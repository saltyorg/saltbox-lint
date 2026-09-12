"""Real process boundary checks; no VS Code or consumer fixture required."""
import json
import contextlib
import io
import os
import pathlib
import sys
import socket
import subprocess
import time
import tempfile
import unittest
import signal
from unittest import mock

import performance
import process_measurement

from performance import measure
from process_measurement import SUPERVISOR


class ProcessMeasurementTests(unittest.TestCase):
    def test_child_rss_excludes_large_orchestrator_and_preserves_io_exit_timing(self):
        # A pre-exec fork image must not be reported as the smaller measured
        # program's peak. Both allocations are touched and remain live.
        orchestrator_memory = b"x" * (96 * 1024 * 1024)
        child = r'''
import json, pathlib, sys, time
memory = b"y" * (20 * 1024 * 1024)
source = sys.stdin.buffer.read()
hwm = int(next(line.split()[1] for line in pathlib.Path('/proc/self/status').read_text().splitlines() if line.startswith('VmHWM:')))
time.sleep(.05)
sys.stdout.buffer.write(json.dumps({'hwm_kib': hwm}).encode() + b'\n' + source)
sys.stdout.buffer.flush()
sys.stderr.buffer.write(b'child stderr\n')
sys.stderr.buffer.flush()
time.sleep(.05)
assert memory[-1] == ord('y')
sys.exit(7)
'''
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            snapshot = root / "snapshot"
            snapshot.write_bytes("snapshot 😀\n".encode())
            prefix = root / "sample"
            result = measure(sys.executable, {"pty": False, "args": ["-c", child], "stdin": str(snapshot)},
                             dict(os.environ), directory, prefix)
            header, source = pathlib.Path(str(prefix) + ".stdout").read_bytes().split(b"\n", 1)
            child_hwm = json.loads(header)["hwm_kib"]
            self.assertEqual(source, snapshot.read_bytes())
            self.assertEqual(pathlib.Path(str(prefix) + ".stderr").read_bytes(), b"child stderr\n")
            self.assertEqual(result["exit"], 7)
            self.assertGreaterEqual(result["first_output_seconds"], .045)
            self.assertGreaterEqual(result["wall_seconds"] - result["first_output_seconds"], .045)
            self.assertLess(result["peak_rss_kib"], child_hwm + 8 * 1024,
                            "reported RSS includes the large pre-exec orchestration image")
        self.assertEqual(orchestrator_memory[-1], ord('x'))

    def test_real_pty_geometry_and_separate_stderr(self):
        child = r'''
import fcntl, json, os, struct, sys, termios
size = struct.unpack('HHHH', fcntl.ioctl(1, termios.TIOCGWINSZ, b'\0' * 8))
print(json.dumps({'tty': os.isatty(1), 'size': size[:2]}), flush=True)
sys.stderr.write('separate stderr\n')
'''
        with tempfile.TemporaryDirectory() as directory:
            prefix = pathlib.Path(directory) / "sample"
            result = measure(sys.executable, {"pty": True, "args": ["-c", child]}, dict(os.environ), directory, prefix)
            stdout = pathlib.Path(str(prefix) + ".stdout").read_bytes()
            self.assertEqual(json.loads(stdout), {"tty": True, "size": [48, 160]})
            self.assertTrue(stdout.endswith(b"\r\n"))
            self.assertEqual(pathlib.Path(str(prefix) + ".stderr").read_bytes(), b"separate stderr\n")
            self.assertEqual(result["exit"], 0)

    def test_ready_wait_is_outside_actual_child_clock(self):
        controller, child_control = socket.socketpair()
        with controller, child_control:
            process = subprocess.Popen([sys.executable, str(SUPERVISOR), str(child_control.fileno()),
                                        sys.executable, "-c", "print('measured child'); raise SystemExit(5)"],
                                       pass_fds=(child_control.fileno(),), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child_control.close()
            with controller.makefile("rwb", buffering=0) as stream:
                ready = json.loads(stream.readline())
                self.assertTrue(ready["ready"])
                ready_at = time.monotonic()
                time.sleep(.075)
                go_at = time.monotonic()
                stream.write(b"go\n")
                stdout, stderr = process.communicate(timeout=10)
                result = json.loads(stream.readline())
            self.assertEqual((stdout, stderr), (b"measured child\n", b""))
            self.assertEqual(result["exit"], 5)
            self.assertGreaterEqual(result["started"], go_at)
            self.assertGreaterEqual(result["started"] - ready_at, .070)
            self.assertGreaterEqual(result["ended"], result["started"])
            self.assertEqual(process.returncode, 0)

    def test_exec_failure_is_a_retained_child_result(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix = pathlib.Path(directory) / "sample"
            result = measure(str(pathlib.Path(directory) / "missing"), {"pty": False, "args": ["argument"]},
                             dict(os.environ), directory, prefix)
            self.assertEqual(result["exit"], 127)
            self.assertEqual(pathlib.Path(str(prefix) + ".stdout").read_bytes(), b"")
            self.assertIn(b"qualification exec failed", pathlib.Path(str(prefix) + ".stderr").read_bytes())

    def test_malformed_ready_retains_streams_and_stops_owned_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            peer = root / "broken_supervisor.py"
            peer.write_text("""
import json, os, pathlib, socket, sys, time
control = socket.socket(fileno=int(sys.argv[1]))
pid = os.fork()
if pid == 0:
    time.sleep(30)
    os._exit(0)
pathlib.Path(__file__).with_suffix('.pids').write_text(json.dumps([os.getpid(), pid]))
os.write(1, b'partial stdout\\n')
os.write(2, b'partial stderr\\n')
control.sendall(b'not json\\n')
time.sleep(30)
""")
            prefix = root / "sample"
            pids = []
            try:
                with mock.patch.object(process_measurement, "SUPERVISOR", peer):
                    try:
                        result = measure(sys.executable, {"pty": False, "args": ["-c", "pass"]},
                                         dict(os.environ), directory, prefix)
                    except Exception:
                        result = {}
                pids = json.loads(peer.with_suffix('.pids').read_text())
                stdout = pathlib.Path(str(prefix) + ".stdout")
                stderr = pathlib.Path(str(prefix) + ".stderr")
                self.assertEqual(stdout.read_bytes() if stdout.exists() else b"", b"partial stdout\n")
                self.assertEqual(stderr.read_bytes() if stderr.exists() else b"", b"partial stderr\n")
                self.assertTrue(result.get("measurement_error"))
                self.assertIsNone(result["peak_rss_kib"])
                self.assertIsNone(result["wall_seconds"])
                for pid in pids:
                    status = pathlib.Path(f"/proc/{pid}/stat")
                    self.assertTrue(not status.exists() or status.read_text().split(') ', 1)[1].startswith('Z'),
                                    "protocol failure left an owned process running")
            finally:
                if peer.with_suffix('.pids').exists():
                    pids = json.loads(peer.with_suffix('.pids').read_text())
                for pid in pids:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_failed_supervisor_attempts_are_flushed_to_series_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            peer = root / "failed_supervisor.py"
            peer.write_text("import os\nos.write(2, b'startup failure\\n')\nraise SystemExit(3)\n")
            manifest = root / "manifest.json"
            manifest.write_text("[]")
            declaration = {"harness_sha256": performance.digest(pathlib.Path(performance.__file__).read_bytes()),
                           "measurement_modules": {}, "manifest": str(manifest),
                           "manifest_sha256": performance.digest(manifest.read_bytes()),
                           "binaries": {label: {"path": sys.executable,
                               "sha256": performance.digest(pathlib.Path(sys.executable).read_bytes())} for label in "AB"},
                           "workloads": [{"name": "failure", "pty": False, "args": ["-c", "pass"]}],
                           "formatting": [], "microbenchmarks": [], "environment": {}, "cwd": directory,
                           "schedule": [{"workload": "failure", "pair": 0, "order": "AB"}]}
            (root / "declaration.json").write_text(json.dumps(declaration))
            with mock.patch.object(process_measurement, "SUPERVISOR", peer), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(Exception):
                    performance.run(directory)
            rows = [json.loads(line) for line in (root / "samples.jsonl").read_text().splitlines()]
            self.assertEqual(len(rows), 2, "failed scheduled attempts were dropped")
            self.assertTrue(all(row["measurement_error"] for row in rows))
            self.assertTrue((root / "failures.json").exists())

    def test_malformed_result_after_go_keeps_partial_streams(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            peer = root / "broken_result.py"
            peer.write_text("""
import os, socket, sys
control = socket.socket(fileno=int(sys.argv[1]))
stream = control.makefile('rwb', buffering=0)
stream.write(b'{"ready": true}\\n')
assert stream.readline() == b'go\\n'
os.write(1, b'partial output\\n')
os.write(2, b'partial error\\n')
stream.write(b'broken result\\n')
raise SystemExit(3)
""")
            prefix = root / "sample"
            with mock.patch.object(process_measurement, "SUPERVISOR", peer):
                result = measure(sys.executable, {"pty": False, "args": ["-c", "pass"]},
                                 dict(os.environ), directory, prefix)
            self.assertTrue(result["measurement_error"])
            self.assertIsNone(result["exit"])
            self.assertEqual(pathlib.Path(str(prefix) + ".stdout").read_bytes(), b"partial output\n")
            self.assertEqual(pathlib.Path(str(prefix) + ".stderr").read_bytes(), b"partial error\n")


if __name__ == "__main__":
    unittest.main()
