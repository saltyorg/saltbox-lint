"""Real process boundary checks; no VS Code or consumer fixture required."""
import json
import os
import pathlib
import sys
import socket
import subprocess
import time
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
