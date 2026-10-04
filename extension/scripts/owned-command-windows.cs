using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// The Job is assigned atomically by CreateProcess, rather than after a child
// could run or after its numeric PID could become stale. The launcher alone
// holds the noninheritable kill-on-close handle.
public static class SaltboxOwnedCommand
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XCharacters, YCharacters, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
        public StartupInfo Startup;
        public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public uint Size;
        public IntPtr Descriptor;
        public int Inherit;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr kind, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool success, string operation) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static IntPtr DuplicateOutput(int kind) {
        IntPtr result;
        Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out result, 0, true, 2), "duplicate owned command output");
        return result;
    }
    static uint Active(IntPtr job) {
        Accounting info;
        Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "query owned command Job");
        return info.ActiveProcesses;
    }
    // Windows argv quoting is independent of PowerShell parsing. The payload
    // contains data only; none of the target command is evaluated as shell code.
    static string Quote(string value) {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') quoted.Append('\\', slashes * 2 + 1);
            else quoted.Append('\\', slashes);
            quoted.Append(character);
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2).Append('"');
        return quoted.ToString();
    }

    public static int Run(string executable, string[] arguments, string directory) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero, handleList = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        bool initialized = false;
        ProcessInfo process = new ProcessInfo();
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "create owned command Job");
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "configure owned command Job");
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(new IntPtr(checked((long)size.ToUInt64())));
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "initialize owned command attributes");
            initialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns ownership at creation.
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000D, jobList, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "assign owned command Job at creation");
            var security = new SecurityAttributes();
            security.Size = (uint)Marshal.SizeOf(typeof(SecurityAttributes));
            security.Inherit = 1;
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Check(input != new IntPtr(-1), "open owned command stdin");
            output = DuplicateOutput(-11);
            error = DuplicateOutput(-12);
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, input);
            Marshal.WriteIntPtr(handleList, IntPtr.Size, output);
            Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, error);
            // Only stdio is inherited. The Job handle must never be inherited.
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handleList, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero), "assign owned command stdio");
            var startup = new StartupInfoEx();
            startup.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Startup.Input = input;
            startup.Startup.Output = output;
            startup.Startup.Error = error;
            startup.Attributes = attributes;
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000, IntPtr.Zero, directory, ref startup, out process), "start owned command in Job");
            CloseHandle(process.Thread);
            process.Thread = IntPtr.Zero;
            // Console.In may implement ReadLineAsync synchronously. Keep its
            // blocking control read off the thread waiting for command exit.
            var stop = Task.Run(() => Console.In.ReadLine());
            uint exitCode = 124;
            while (!stop.IsCompleted) {
                uint waited = WaitForSingleObject(process.Process, 50);
                if (waited == 0) {
                    Check(GetExitCodeProcess(process.Process, out exitCode), "read owned command exit code");
                    break;
                }
                Check(waited == 258, "wait for owned command");
            }
            // Command exit and deadline both terminate any remaining Job members.
            // Release the process handle before checking the Job's active count.
            Check(TerminateJobObject(job, 124), "terminate owned command Job");
            CloseHandle(process.Process);
            process.Process = IntPtr.Zero;
            var reaping = Stopwatch.StartNew();
            while (Active(job) != 0) {
                if (reaping.ElapsedMilliseconds >= 5000)
                    throw new Exception("owned command Job did not reap within 5000ms");
                Thread.Sleep(10);
            }
            return unchecked((int)exitCode);
        } finally {
            // Even setup exceptions and a forcibly terminated launcher close the
            // last Job handle. No numeric process ID is used for cleanup.
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
        }
    }
}
