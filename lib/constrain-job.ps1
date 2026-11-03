# The Windows side of flow-review constrain: a job object holding every process put in it and everything they start,
# capping their committed memory, and slowing their CPU, either with the job's hard CPU-rate cap or by suspending and
# resuming all of them in turn (a duty cycle). It reads commands on stdin, one a line, and answers in JSON:
#   assign <pid>             puts a process in the job (its later children are in it from birth)
#   rate <n>                 sets the hard cap to n cycles in 10,000 across all processors
#   duty <ratio> <periodMs>  starts the duty cycle: run 1/ratio of every period
#   ratio <r>                changes the duty cycle's ratio
#   report                   prints the job's peak memory, memory-limit hits, CPU time and the duty cycle's account,
#                            then closes the job, which ends anything still running in it
param([long]$CpuRate = 0, [long]$MemoryBytes = 0)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

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
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, IntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out IntPtr key, out IntPtr overlapped, uint milliseconds);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr process);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr process);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint milliseconds);

  const int BasicAccountingInformation = 1, BasicProcessIdList = 3, AssociateCompletionPortInformation = 7, ExtendedLimitInformation = 9, CpuRateControlInformation = 15;
  const uint PROCESS_SUSPEND_RESUME = 0x800, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
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

  static readonly object sayLock = new object();
  static void Say(string json) { lock (sayLock) { Console.Out.WriteLine(json); Console.Out.Flush(); } }

  static void SetRate(IntPtr job, long cpuRate) {
    CpuRateControl c = new CpuRateControl(); c.ControlFlags = CPU_RATE_CONTROL_ENABLE | CPU_RATE_CONTROL_HARD_CAP; c.CpuRate = (uint)cpuRate;
    Set(job, CpuRateControlInformation, c);
  }

  // The job's processes, as its kernel list has them: no process in the job can be missed.
  static List<int> Pids(IntPtr job) {
    int capacity = 4096;
    int size = 8 + IntPtr.Size * capacity;
    IntPtr p = Marshal.AllocHGlobal(size);
    List<int> pids = new List<int>();
    try {
      if (!QueryInformationJobObject(job, BasicProcessIdList, p, (uint)size, IntPtr.Zero)) return pids;
      int n = Marshal.ReadInt32(p, 4);
      for (int i = 0; i < n; i++) pids.Add((int)Marshal.ReadIntPtr(p, 8 + i * IntPtr.Size).ToInt64());
    } finally { Marshal.FreeHGlobal(p); }
    return pids;
  }

  // The duty cycle: every process in the job suspended and resumed in turn, so each thread runs 1/ratio of the time.
  static volatile bool dutyOn;
  static double dutyRatio = 1;
  static int dutyPeriod = 50;
  static double dutyRan, dutyPaused;
  static int dutyCycles;
  static Thread dutyThread;
  static readonly Dictionary<int, IntPtr> handles = new Dictionary<int, IntPtr>();

  // A handle held open keeps its process's pid from being given to another process, so a cached handle is always the
  // process the job lists under that pid. A pid is opened only if the process under it is in the job: one that ended
  // between the listing and the open may have given its pid to a process outside it, which is never suspended. A
  // process that couldn't be opened isn't cached, so it is tried again next time. Handles of processes that left the
  // job are closed every pass.
  static void All(IntPtr job, bool suspend) {
    List<int> pids = Pids(job);
    foreach (int pid in pids) {
      IntPtr h;
      if (!handles.TryGetValue(pid, out h)) {
        h = OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) continue;
        bool inJob;
        if (!IsProcessInJob(h, job, out inJob) || !inJob) { CloseHandle(h); continue; }
        handles[pid] = h;
      }
      if (suspend) NtSuspendProcess(h); else NtResumeProcess(h);
    }
    if (handles.Count > pids.Count) {
      Dictionary<int, bool> live = new Dictionary<int, bool>();
      foreach (int pid in pids) live[pid] = true;
      List<int> gone = new List<int>();
      foreach (int pid in handles.Keys) if (!live.ContainsKey(pid)) gone.Add(pid);
      foreach (int pid in gone) { CloseHandle(handles[pid]); handles.Remove(pid); }
    }
  }

  static void Sleep(double ms) { if (ms >= 1) Thread.Sleep((int)Math.Round(ms)); }

  static void Duty(IntPtr job) {
    timeBeginPeriod(1);
    Stopwatch clock = Stopwatch.StartNew();
    double factor = dutyRatio;
    double on = clock.Elapsed.TotalMilliseconds;
    while (dutyOn) {
      Sleep(dutyPeriod / factor);
      All(job, true);
      double off = clock.Elapsed.TotalMilliseconds;
      dutyRan += off - on;
      if (!dutyOn) break;
      double wanted = Thread.VolatileRead(ref dutyRatio);
      if (wanted != factor) { factor = wanted; dutyRan = off - on; dutyPaused = 0; }
      Sleep(dutyRan * (factor - 1) - dutyPaused);
      All(job, false);
      on = clock.Elapsed.TotalMilliseconds;
      dutyPaused += on - off;
      dutyCycles++;
    }
    All(job, false);
  }

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
      if (cpuRate > 0) SetRate(job, cpuRate);
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
      } else if (line.StartsWith("rate ")) {
        long rate = long.Parse(line.Substring(5), CultureInfo.InvariantCulture);
        try { SetRate(job, rate); Say("{\"rate\":" + rate + "}"); } catch (Exception e) { Say("{\"error\":\"" + e.Message.Replace("\"", "'") + "\"}"); }
      } else if (line.StartsWith("duty ")) {
        string[] parts = line.Split(' ');
        dutyRatio = double.Parse(parts[1], CultureInfo.InvariantCulture);
        dutyPeriod = int.Parse(parts[2], CultureInfo.InvariantCulture);
        dutyOn = true;
        IntPtr j = job;
        dutyThread = new Thread(delegate () { Duty(j); });
        dutyThread.IsBackground = true;
        dutyThread.Priority = ThreadPriority.Highest;
        dutyThread.Start();
        Say("{\"duty\":" + dutyRatio.ToString(CultureInfo.InvariantCulture) + "}");
      } else if (line.StartsWith("ratio ")) {
        dutyRatio = double.Parse(line.Substring(6), CultureInfo.InvariantCulture);
        Say("{\"ratio\":" + dutyRatio.ToString(CultureInfo.InvariantCulture) + "}");
      } else if (line == "report") break;
    }
    if (dutyThread != null) { dutyOn = false; dutyThread.Join(); }

    int memoryHits = 0;
    uint msg; IntPtr key; IntPtr overlapped;
    while (GetQueuedCompletionStatus(port, out msg, out key, out overlapped, 0)) {
      if (msg == MSG_JOB_MEMORY_LIMIT || msg == MSG_PROCESS_MEMORY_LIMIT) memoryHits++;
    }
    ExtendedLimit e2 = Get<ExtendedLimit>(job, ExtendedLimitInformation);
    Accounting a = Get<Accounting>(job, BasicAccountingInformation);
    Say(string.Format(CultureInfo.InvariantCulture, "{{\"peakJobMemory\":{0},\"peakProcessMemory\":{1},\"memoryLimitHits\":{2},\"cpuSeconds\":{3},\"processes\":{4},\"leftRunning\":{5},\"dutyRanMs\":{6},\"dutyPausedMs\":{7},\"dutyCycles\":{8}}}",
      e2.PeakJobMemoryUsed.ToUInt64(), e2.PeakProcessMemoryUsed.ToUInt64(), memoryHits, (a.TotalUserTime + a.TotalKernelTime) / 1e7, a.TotalProcesses, a.ActiveProcesses, Math.Round(dutyRan), Math.Round(dutyPaused), dutyCycles));
    foreach (IntPtr h in handles.Values) if (h != IntPtr.Zero) CloseHandle(h);
    CloseHandle(job);
    CloseHandle(port);
    return 0;
  }
}
'@
exit [FlowReviewJob]::Serve($CpuRate, $MemoryBytes)
