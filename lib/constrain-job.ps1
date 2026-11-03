# The Windows side of flow-review constrain: a job object that caps the CPU rate (a hard cap) and the committed memory
# of every process put in it and everything they start. It reads commands on stdin, one a line, and answers in JSON:
#   assign <pid>   puts a process in the job (its later children are in it from birth)
#   report         prints the job's peak memory, memory-limit hits and CPU time, then closes the job, which ends
#                  anything still running in it
param([long]$CpuRate = 0, [long]$MemoryBytes = 0)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class FlowReviewJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct CpuRateControl { public uint ControlFlags; public uint CpuRate; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential)] struct CompletionPort { public IntPtr CompletionKey; public IntPtr Port; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, IntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out IntPtr key, out IntPtr overlapped, uint milliseconds);

  const int BasicAccountingInformation = 1, AssociateCompletionPortInformation = 7, ExtendedLimitInformation = 9, CpuRateControlInformation = 15;
  const uint LIMIT_JOB_MEMORY = 0x200, LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const uint CPU_RATE_CONTROL_ENABLE = 0x1, CPU_RATE_CONTROL_HARD_CAP = 0x4;
  const uint MSG_PROCESS_MEMORY_LIMIT = 9, MSG_JOB_MEMORY_LIMIT = 10;
  const uint PROCESS_TERMINATE = 0x1, PROCESS_SET_QUOTA = 0x100;

  static void Set<T>(IntPtr job, int infoClass, T value) where T : struct {
    int n = Marshal.SizeOf(typeof(T));
    IntPtr p = Marshal.AllocHGlobal(n);
    try {
      Marshal.StructureToPtr(value, p, false);
      if (!SetInformationJobObject(job, infoClass, p, (uint)n)) throw new Exception("SetInformationJobObject(" + infoClass + ") failed with error " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(p); }
  }

  static T Get<T>(IntPtr job, int infoClass) where T : struct {
    int n = Marshal.SizeOf(typeof(T));
    IntPtr p = Marshal.AllocHGlobal(n);
    try {
      if (!QueryInformationJobObject(job, infoClass, p, (uint)n, IntPtr.Zero)) throw new Exception("QueryInformationJobObject(" + infoClass + ") failed with error " + Marshal.GetLastWin32Error());
      return (T)Marshal.PtrToStructure(p, typeof(T));
    } finally { Marshal.FreeHGlobal(p); }
  }

  static void Say(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }

  public static int Serve(long cpuRate, long memoryBytes) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { Say("{\"error\":\"CreateJobObject failed with error " + Marshal.GetLastWin32Error() + "\"}"); return 1; }
    IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1);
    try {
      CompletionPort cp = new CompletionPort(); cp.CompletionKey = job; cp.Port = port;
      Set(job, AssociateCompletionPortInformation, cp);
      ExtendedLimit ext = new ExtendedLimit();
      ext.Basic.LimitFlags = LIMIT_KILL_ON_JOB_CLOSE;
      if (memoryBytes > 0) { ext.Basic.LimitFlags |= LIMIT_JOB_MEMORY; ext.JobMemoryLimit = new UIntPtr((ulong)memoryBytes); }
      Set(job, ExtendedLimitInformation, ext);
      if (cpuRate > 0) {
        CpuRateControl c = new CpuRateControl(); c.ControlFlags = CPU_RATE_CONTROL_ENABLE | CPU_RATE_CONTROL_HARD_CAP; c.CpuRate = (uint)cpuRate;
        Set(job, CpuRateControlInformation, c);
      }
    } catch (Exception e) { Say("{\"error\":\"" + e.Message.Replace("\"", "'") + "\"}"); return 1; }
    Say("{\"ready\":true,\"cpuRate\":" + cpuRate + ",\"memoryBytes\":" + memoryBytes + "}");

    string line;
    while ((line = Console.In.ReadLine()) != null) {
      line = line.Trim();
      if (line.StartsWith("assign ")) {
        int pid = int.Parse(line.Substring(7), CultureInfo.InvariantCulture);
        IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        bool ok = h != IntPtr.Zero && AssignProcessToJobObject(job, h);
        int err = ok ? 0 : Marshal.GetLastWin32Error();
        if (h != IntPtr.Zero) CloseHandle(h);
        Say(ok ? "{\"assigned\":" + pid + "}" : "{\"error\":\"AssignProcessToJobObject(" + pid + ") failed with error " + err + "\"}");
      } else if (line == "report") break;
    }

    int memoryHits = 0;
    uint msg; IntPtr key; IntPtr overlapped;
    while (GetQueuedCompletionStatus(port, out msg, out key, out overlapped, 0)) {
      if (msg == MSG_JOB_MEMORY_LIMIT || msg == MSG_PROCESS_MEMORY_LIMIT) memoryHits++;
    }
    ExtendedLimit e2 = Get<ExtendedLimit>(job, ExtendedLimitInformation);
    Accounting a = Get<Accounting>(job, BasicAccountingInformation);
    Say(string.Format(CultureInfo.InvariantCulture, "{{\"peakJobMemory\":{0},\"peakProcessMemory\":{1},\"memoryLimitHits\":{2},\"cpuSeconds\":{3},\"processes\":{4},\"leftRunning\":{5}}}",
      e2.PeakJobMemoryUsed.ToUInt64(), e2.PeakProcessMemoryUsed.ToUInt64(), memoryHits, (a.TotalUserTime + a.TotalKernelTime) / 1e7, a.TotalProcesses, a.ActiveProcesses));
    CloseHandle(job);
    CloseHandle(port);
    return 0;
  }
}
'@
exit [FlowReviewJob]::Serve($CpuRate, $MemoryBytes)
