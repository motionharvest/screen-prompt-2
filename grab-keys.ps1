# Holds the keyboard back from the rest of the system while a key combination
# is being recorded, and reports what was pressed.
#
# Long-lived and fed over stdin, in the same style as the ASR, ducking and
# typing helpers. The commands are bare words rather than JSON, because there
# are two of them:
#
#     in   grab                                   start swallowing
#     in   release                                stop
#     out  {"event":"status","state":"ready"}
#     out  {"event":"grabbed"}   {"event":"released"}
#     out  {"event":"key","down":true,"scan":32,"extended":false}
#
# Why this exists. uiohook, which the app already listens to, observes the
# keyboard: every key it reports has already been delivered to whoever it was
# going to. That is right for a push-to-talk shortcut and wrong for recording
# one, because Win+D reaches the shell and shows the desktop before the
# recorder ever hears about it. The only thing on Windows that runs ahead of
# the shell's own hotkeys is a WH_KEYBOARD_LL hook that returns 1, and that
# needs a process with a message pump, which is what this is.
#
# Scan codes rather than virtual keys, because a combination is about which key
# was pressed, not which letter it would have produced, and because the scan
# code is what goes back out again when the combination is sent.
#
# Three things it deliberately does not swallow. Injected keys are passed
# through, so the app never records what it just sent itself. Ctrl+Alt+Del and
# Win+L are handled below the hook by Windows and cannot be swallowed by
# anything. And the hook comes off by itself if nothing releases it, so a
# recording that goes wrong cannot hold the keyboard for longer than the limit
# below.

$ErrorActionPreference = 'Stop'

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace ScreenPrompt {

public static class Grab {
  const int WH_KEYBOARD_LL = 13;
  const int WM_KEYDOWN = 0x0100;
  const int WM_KEYUP = 0x0101;
  const int WM_SYSKEYDOWN = 0x0104;
  const int WM_SYSKEYUP = 0x0105;
  const uint LLKHF_EXTENDED = 0x01;
  const uint LLKHF_INJECTED = 0x10;

  // Posted to the pump thread. A low-level hook's callback runs on the thread
  // that installed it, and only a thread that pumps messages gets called at
  // all, so installing and removing both have to happen there rather than on
  // the thread reading stdin.
  const uint AppGrab = 0x8001;
  const uint AppRelease = 0x8002;
  const uint AppQuit = 0x8003;

  // How long the keyboard may stay held with nothing releasing it. The app
  // releases it when the field loses focus and again when its window is
  // hidden, so reaching this means something went wrong upstream — and a
  // keyboard nobody can type on is much worse than a recording that stopped.
  const int GrabLimitSeconds = 120;

  [StructLayout(LayoutKind.Sequential)]
  struct KBDLLHOOKSTRUCT {
    public uint vkCode; public uint scanCode; public uint flags;
    public uint time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct MSG {
    public IntPtr hwnd; public uint message; public IntPtr wParam;
    public IntPtr lParam; public uint time; public int x; public int y;
  }

  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr mod, uint threadId);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")]
  static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool PostThreadMessage(uint thread, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")]
  static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
  static extern IntPtr GetModuleHandle(string name);

  static IntPtr hook = IntPtr.Zero;
  // Held in a static on purpose. A delegate handed to unmanaged code is not
  // rooted by the hook, so letting this go out of scope would leave Windows
  // calling a collected callback the next time a key is pressed.
  static HookProc proc;
  static uint pumpThread;
  static DateTime grabbedAt;
  static readonly object writeLock = new object();

  // Written straight from the hook callback. A low-level hook has a few
  // seconds to answer before Windows drops it, and a line down a pipe that the
  // app is reading costs microseconds. If the app ever did stop reading, the
  // hook would be dropped and keys would flow again — which is the right way
  // for this to fail.
  static void Emit(string line) {
    lock (writeLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  }

  static IntPtr Callback(int code, IntPtr wParam, IntPtr lParam) {
    if (code < 0 || hook == IntPtr.Zero) {
      return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    KBDLLHOOKSTRUCT info =
      (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
    // Synthetic keys are the app's own, or another tool's. Swallowing them
    // would make a recording capture whatever it had just sent.
    if ((info.flags & LLKHF_INJECTED) != 0) {
      return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    int msg = wParam.ToInt32();
    bool down = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
    if (!down && msg != WM_KEYUP && msg != WM_SYSKEYUP) {
      return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    Emit("{\"event\":\"key\",\"down\":" + (down ? "true" : "false")
      + ",\"scan\":" + info.scanCode
      + ",\"extended\":" + (((info.flags & LLKHF_EXTENDED) != 0) ? "true" : "false")
      + "}");
    return (IntPtr)1;
  }

  static void Install() {
    if (hook != IntPtr.Zero) { Emit("{\"event\":\"grabbed\"}"); return; }
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) {
      Emit("{\"event\":\"error\",\"detail\":\"SetWindowsHookEx failed with "
        + Marshal.GetLastWin32Error() + "\"}");
      return;
    }
    grabbedAt = DateTime.UtcNow;
    Emit("{\"event\":\"grabbed\"}");
  }

  static void Remove() {
    if (hook == IntPtr.Zero) return;
    UnhookWindowsHookEx(hook);
    hook = IntPtr.Zero;
    Emit("{\"event\":\"released\"}");
  }

  static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      line = line.Trim();
      if (line == "grab") PostThreadMessage(pumpThread, AppGrab, IntPtr.Zero, IntPtr.Zero);
      else if (line == "release") PostThreadMessage(pumpThread, AppRelease, IntPtr.Zero, IntPtr.Zero);
    }
    // Stdin closed: whoever started us is gone, and a hook with nobody left to
    // release it is exactly what the limit below is for. Go now instead.
    PostThreadMessage(pumpThread, AppQuit, IntPtr.Zero, IntPtr.Zero);
  }

  static void Watchdog() {
    while (true) {
      Thread.Sleep(1000);
      if (hook == IntPtr.Zero) continue;
      if ((DateTime.UtcNow - grabbedAt).TotalSeconds < GrabLimitSeconds) continue;
      PostThreadMessage(pumpThread, AppRelease, IntPtr.Zero, IntPtr.Zero);
    }
  }

  public static void Run() {
    proc = Callback;
    pumpThread = GetCurrentThreadId();
    Thread reader = new Thread(ReadCommands);
    reader.IsBackground = true;
    reader.Start();
    Thread watchdog = new Thread(Watchdog);
    watchdog.IsBackground = true;
    watchdog.Start();
    Emit("{\"event\":\"status\",\"state\":\"ready\"}");

    MSG msg;
    int got;
    // hwnd zero so the thread messages posted above are delivered here. A
    // return of 0 is WM_QUIT and -1 is an error; both mean stop.
    while ((got = GetMessage(out msg, IntPtr.Zero, 0, 0)) > 0) {
      if (msg.message == AppGrab) Install();
      else if (msg.message == AppRelease) Remove();
      else if (msg.message == AppQuit) break;
    }
    Remove();
  }
}

}
'@
} catch {
  Emit @{ event = 'status'; state = 'error'; detail = $_.Exception.Message }
  exit 1
}

[ScreenPrompt.Grab]::Run()
