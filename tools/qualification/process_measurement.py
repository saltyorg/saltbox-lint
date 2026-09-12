"""Measure a real CLI through a fresh, ready supervisor and identical sinks."""
import fcntl
import hashlib
import json
import math
import os
import pathlib
import pty
import selectors
import signal
import socket
import struct
import subprocess
import sys
import termios
import time

SUPERVISOR = pathlib.Path(__file__).with_name("process_supervisor.py")


def _drain(master, process, outputs, control=None):
    first = last = child = None
    control_bytes = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(master if master is not None else process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        if control is not None:
            selector.register(control, selectors.EVENT_READ, "control")
        while selector.get_map():
            for key, _ in selector.select(timeout=1):
                if key.data == "control":
                    chunk = control.recv(65536)
                    if not chunk:
                        selector.unregister(control)
                        if child is None:
                            raise ValueError("supervisor control closed before a child result")
                        continue
                    control_bytes.extend(chunk)
                    if b"\n" in control_bytes:
                        line, remainder = control_bytes.split(b"\n", 1)
                        if child is not None or remainder:
                            raise ValueError("multiple supervisor results")
                        child = json.loads(line)
                        _validate(child)
                        control_bytes.clear()
                    continue
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError as error:
                    if master == key.fd and error.errno == 5:
                        chunk = b""
                    else:
                        raise
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    last = time.monotonic()
                    if first is None:
                        first = last
                    outputs[key.data].extend(chunk)
    return first, last, child


def _stop(process):
    # The supervisor starts a dedicated session; its measured child and Git
    # descendants inherit that group. A broken protocol grants no orphan lease.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _validate(child):
    if not isinstance(child, dict):
        raise ValueError("supervisor result is not an object")
    for key in ("started", "ended", "cpu_user_seconds", "cpu_system_seconds",
                "supervisor_cpu_user_seconds", "supervisor_cpu_system_seconds"):
        value = child.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError(f"invalid supervisor metric: {key}")
    for key in ("exit", "peak_rss_kib", "supervisor_hwm_kib"):
        if type(child.get(key)) is not int:
            raise ValueError(f"invalid supervisor metric: {key}")
    if child["ended"] < child["started"] or child["peak_rss_kib"] < 0 or child["supervisor_hwm_kib"] < 0:
        raise ValueError("invalid supervisor timing or RSS")


def measure(binary, work, env, cwd, prefix):
    master = slave = None
    if work["pty"]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 160, 0, 0))
    controller, child_control = socket.socketpair()
    controller.settimeout(30)
    stdin = open(work["stdin"], "rb") if work.get("stdin") else open(os.devnull, "rb")
    launched = time.monotonic()
    process = subprocess.Popen([sys.executable, str(SUPERVISOR), str(child_control.fileno()), binary, *work["args"]],
                               cwd=cwd, env=env, stdin=stdin, start_new_session=True,
                               stdout=slave if slave is not None else subprocess.PIPE,
                               stderr=subprocess.PIPE, pass_fds=(child_control.fileno(),))
    child_control.close()
    stdin.close()
    if slave is not None:
        os.close(slave)
    stream = controller.makefile("rwb", buffering=0)
    outputs = {"stdout": bytearray(), "stderr": bytearray()}
    first = last = ready_at = None
    failure = None
    try:
        ready = json.loads(stream.readline())
        if ready.get("ready") is not True:
            raise RuntimeError("measurement supervisor is not ready")
        ready_at = time.monotonic()
        controller.settimeout(None)
        stream.write(b"go\n")
        first, last, child = _drain(master, process, outputs, controller)
        if process.wait() != 0:
            raise RuntimeError("measurement supervisor failed")
        finished = time.monotonic()
        if first is not None and first < child["started"]:
            raise ValueError("output predates the measured child")
    except Exception as error:
        failure = f"{type(error).__name__}: {error}"
        _stop(process)
        _drain(master, process, outputs)
        process.wait()
    finally:
        if process.returncode is None:
            _stop(process)
            _drain(master, process, outputs)
            process.wait()
        stream.close()
        controller.close()
        if master is not None:
            os.close(master)
        if process.stdout:
            process.stdout.close()
        process.stderr.close()
        # Keep every available byte even when control decoding or wait fails.
        for name, data in outputs.items():
            pathlib.Path(str(prefix) + "." + name).write_bytes(data)
    hashes = {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
              for name, data in outputs.items()}
    if failure:
        return {"measurement_error": failure, "supervisor_exit": process.returncode,
                "exit": None, "wall_seconds": None, "first_output_seconds": None,
                "cpu_user_seconds": None, "cpu_system_seconds": None, "peak_rss_kib": None,
                "rss_exceeds_supervisor_hwm": False, "outputs": hashes}
    started = child.pop("started")
    ended = child.pop("ended")
    result = {**child, "wall_seconds": max(ended, last or ended) - started,
              "command_wall_seconds": ended - started,
              "first_output_seconds": first - started if first is not None else None,
              "supervisor_startup_seconds": ready_at - launched,
              "ready_to_child_start_seconds": started - ready_at,
              "supervisor_finish_seconds": finished - ended,
              "rss_exceeds_supervisor_hwm": child["peak_rss_kib"] > child["supervisor_hwm_kib"],
              "outputs": hashes}
    if work["args"][0] == "format" and result["exit"] == 0:
        try:
            result["format_status"] = json.loads(outputs["stdout"])["status"]
        except (ValueError, KeyError, TypeError) as error:
            result["measurement_error"] = f"invalid formatter response: {error}"
    return result
