"""Small Linux supervisor: start the actual measured child only after readiness."""
import json
import os
import resource
import socket
import sys
import time


def main():
    control = socket.socket(fileno=int(sys.argv[1]))
    control.set_inheritable(False)
    stream = control.makefile("rwb", buffering=0)
    high_water = int(next(line.split()[1] for line in open("/proc/self/status")
                          if line.startswith("VmHWM:")))
    stream.write(json.dumps({"ready": True, "supervisor_hwm_kib": high_water}).encode() + b"\n")
    if stream.readline() != b"go\n":
        raise RuntimeError("measurement controller did not authorize child start")
    high_water = int(next(line.split()[1] for line in open("/proc/self/status")
                          if line.startswith("VmHWM:")))
    started = time.monotonic()
    pid = os.fork()
    if pid == 0:
        stream.close()
        control.close()
        try:
            os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
        except OSError as error:
            os.write(2, f"qualification exec failed: {error}\n".encode())
            os._exit(127)
    _, status, usage = os.wait4(pid, 0)
    ended = time.monotonic()
    overhead = resource.getrusage(resource.RUSAGE_SELF)
    result = {"started": started, "ended": ended, "exit": os.waitstatus_to_exitcode(status),
              "cpu_user_seconds": usage.ru_utime, "cpu_system_seconds": usage.ru_stime,
              "peak_rss_kib": usage.ru_maxrss, "supervisor_hwm_kib": high_water,
              "supervisor_cpu_user_seconds": overhead.ru_utime,
              "supervisor_cpu_system_seconds": overhead.ru_stime}
    stream.write(json.dumps(result).encode() + b"\n")
    stream.close()
    control.close()


if __name__ == "__main__":
    main()
