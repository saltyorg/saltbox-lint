"""Measure a real CLI through a fresh, ready supervisor and identical sinks."""
import fcntl
import hashlib
import json
import os
import pathlib
import pty
import selectors
import socket
import struct
import subprocess
import sys
import termios
import time

SUPERVISOR = pathlib.Path(__file__).with_name("process_supervisor.py")


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
                               cwd=cwd, env=env, stdin=stdin,
                               stdout=slave if slave is not None else subprocess.PIPE,
                               stderr=subprocess.PIPE, pass_fds=(child_control.fileno(),))
    child_control.close()
    stdin.close()
    if slave is not None:
        os.close(slave)
    stream = controller.makefile("rwb", buffering=0)
    outputs = {"stdout": bytearray(), "stderr": bytearray()}
    first = last = None
    try:
        ready = json.loads(stream.readline())
        if ready.get("ready") is not True:
            raise RuntimeError("measurement supervisor is not ready")
        ready_at = time.monotonic()
        controller.settimeout(None)
        stream.write(b"go\n")
        with selectors.DefaultSelector() as selector:
            selector.register(master if master is not None else process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                for key, _ in selector.select(timeout=1):
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
        child = json.loads(stream.readline())
        if process.wait() != 0:
            raise RuntimeError("measurement supervisor failed")
        finished = time.monotonic()
    finally:
        stream.close()
        controller.close()
        if master is not None:
            os.close(master)
        if process.stdout:
            process.stdout.close()
        process.stderr.close()
    for name, data in outputs.items():
        pathlib.Path(str(prefix) + "." + name).write_bytes(data)
    started = child.pop("started")
    ended = child.pop("ended")
    result = {**child, "wall_seconds": max(ended, last or ended) - started,
              "command_wall_seconds": ended - started,
              "first_output_seconds": first - started if first is not None else None,
              "supervisor_startup_seconds": ready_at - launched,
              "ready_to_child_start_seconds": started - ready_at,
              "supervisor_finish_seconds": finished - ended,
              "rss_exceeds_supervisor_hwm": child["peak_rss_kib"] > child["supervisor_hwm_kib"],
              "outputs": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                          for name, data in outputs.items()}}
    if work["args"][0] == "format" and result["exit"] == 0:
        result["format_status"] = json.loads(outputs["stdout"])["status"]
    return result
