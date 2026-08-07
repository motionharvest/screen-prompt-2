# Volume ducking helper: turns every other app's audio down while Screen
# Prompt 2 is recording, then puts each session back exactly where it was.
#
# Speaks the same JSON-lines protocol as the ASR sidecar:
#   in   {"cmd":"duck","level":0.2,"skipName":"electron"}   {"cmd":"restore"}
#   out  {"event":"status","state":"ready"}   {"event":"ducked","sessions":3}
#
# PowerShell because the Core Audio session API is COM-only — a native Node
# addon would need a build toolchain on every machine that installs this, for
# one call. The read loop below ends when stdin closes, and the `finally`
# restores on the way out, so killing the app can never leave the rest of the
# system turned down.

$ErrorActionPreference = 'Stop'

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace ScreenPrompt {

// Core Audio interop. Every method carries [PreserveSig] and returns the raw
// HRESULT: these interfaces are hand-declared, and letting the runtime turn
// HRESULTs into exceptions would also rewrite the signatures (last [out]
// becomes the return), which is easy to get subtly wrong. Methods this file
// never calls still have to be declared, in order, to keep the vtable layout
// right — their pointer arguments are typed as IntPtr so nothing is marshaled.

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                             [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
  [PreserveSig] int GetId(out IntPtr id);
  [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  [PreserveSig] int RegisterSessionNotification(IntPtr notifications);
  [PreserveSig] int UnregisterSessionNotification(IntPtr notifications);
  [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr n);
  [PreserveSig] int UnregisterDuckNotification(IntPtr n);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
  // IAudioSessionControl
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr name);
  [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, IntPtr context);
  [PreserveSig] int GetIconPath(out IntPtr path);
  [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, IntPtr context);
  [PreserveSig] int GetGroupingParam(out Guid grouping);
  [PreserveSig] int SetGroupingParam(IntPtr overrideId, IntPtr context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr notifications);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notifications);
  // IAudioSessionControl2
  [PreserveSig] int GetSessionIdentifier(out IntPtr id);
  [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
  [PreserveSig] int SetDuckingPreference(int optOut);
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
  [PreserveSig] int SetMasterVolume(float level, ref Guid context);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute(int mute, ref Guid context);
  [PreserveSig] int GetMute(out int mute);
}

public class Ducker {
  const int ERender = 0, EConsole = 0, ClsCtxAll = 23, SessionExpired = 2;
  static Guid context = Guid.Empty;

  // Nothing is ever turned down below this, whatever the level asks for. If the
  // originals are ever lost the volumes cannot then be driven to true silence
  // one recording at a time — the damage is bounded at something still audible.
  const float MinDucked = 0.02f;

  public class Entry {
    public ISimpleAudioVolume Volume;
    public float Original;
    // The per-application session id, which unlike the COM pointer survives
    // this process dying. Windows persists a session's volume against it, so it
    // is also what makes the volume recoverable after the app itself restarts.
    public string Id;
  }

  // Holding the ISimpleAudioVolume references (rather than re-enumerating and
  // matching by session id on the way back) is what makes restore exact: the
  // object we put back is the one we turned down, even if the session list has
  // changed shape in between.
  List<Entry> saved = new List<Entry>();

  public List<Entry> Saved { get { return saved; } }

  static string IdOf(IAudioSessionControl2 control) {
    IntPtr p;
    if (control.GetSessionIdentifier(out p) != 0 || p == IntPtr.Zero) return null;
    try { return Marshal.PtrToStringUni(p); }
    finally { Marshal.FreeCoTaskMem(p); }
  }

  // Puts back volumes recorded by a *previous* process that never got to
  // restore them — a crash, a kill, a machine powered off mid-recording. Those
  // sessions are matched by id rather than by object, because the objects died
  // with the process that held them.
  public int RestoreFrom(string[] ids, float[] originals) {
    if (ids == null || originals == null) return 0;
    var want = new Dictionary<string, float>();
    for (int i = 0; i < ids.Length && i < originals.Length; i++) {
      if (!String.IsNullOrEmpty(ids[i])) want[ids[i]] = originals[i];
    }
    if (want.Count == 0) return 0;

    int restored = 0;
    foreach (var pair in Enumerate()) {
      var control = pair.Key;
      var volume = pair.Value;
      try {
        string id = IdOf(control);
        float original;
        if (id == null || !want.TryGetValue(id, out original)) continue;
        float current;
        // Only raise. If the session is already louder than the value we were
        // going to put back, something has legitimately changed it since and
        // pulling it back down would be the wrong move.
        if (volume.GetMasterVolume(out current) == 0 && current >= original) continue;
        if (volume.SetMasterVolume(original, ref context) == 0) restored++;
      } catch { }
    }
    return restored;
  }

  // Shared walk of the session list; the two callers differ only in what they
  // do with each session.
  List<KeyValuePair<IAudioSessionControl2, ISimpleAudioVolume>> Enumerate() {
    var found = new List<KeyValuePair<IAudioSessionControl2, ISimpleAudioVolume>>();
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice device;
    if (enumerator.GetDefaultAudioEndpoint(ERender, EConsole, out device) != 0 || device == null)
      return found;

    Guid iid = typeof(IAudioSessionManager2).GUID;
    object managerObj;
    if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out managerObj) != 0 || managerObj == null)
      return found;

    IAudioSessionEnumerator sessions;
    if (((IAudioSessionManager2)managerObj).GetSessionEnumerator(out sessions) != 0) return found;

    int count;
    if (sessions.GetCount(out count) != 0) return found;

    for (int i = 0; i < count; i++) {
      object sessionObj;
      if (sessions.GetSession(i, out sessionObj) != 0 || sessionObj == null) continue;
      try {
        found.Add(new KeyValuePair<IAudioSessionControl2, ISimpleAudioVolume>(
          (IAudioSessionControl2)sessionObj, (ISimpleAudioVolume)sessionObj));
      } catch { }
    }
    return found;
  }

  public int Duck(float level, uint[] skipPids) {
    Restore();
    var skip = new HashSet<uint>(skipPids ?? new uint[0]);

    foreach (var pair in Enumerate()) {
      var control = pair.Key;
      var volume = pair.Value;
      try {
        int state;
        if (control.GetState(out state) == 0 && state == SessionExpired) continue;
        // S_OK means this IS the system sounds session; leave Windows' own
        // blips alone, they are too short to talk over.
        if (control.IsSystemSoundsSession() == 0) continue;

        uint pid;
        if (control.GetProcessId(out pid) == 0 && skip.Contains(pid)) continue;

        // Inactive sessions are ducked too, so an app that starts playing
        // midway through a recording comes in already quiet.
        float current;
        if (volume.GetMasterVolume(out current) != 0) continue;

        // Compared against the level applied to *full scale* — which is 1.0
        // here — not to this session's own volume. A session already at or
        // below where a full-volume one would be put is quiet enough already,
        // and ducking it again would record the ducked value as its original,
        // which is how one lost restore turns into silence a recording at a
        // time.
        // The epsilon matters: a session sitting at exactly the ducked volume
        // comes back through the float32 API a hair above it and would
        // otherwise be ducked a second time.
        if (current <= level * 1.001f) continue;

        float target = current * level;
        if (target < MinDucked) target = MinDucked;

        // Recorded before the write, not after. A SetMasterVolume that reports
        // failure may still have changed something, and a session left out of
        // `saved` is a session that never gets put back.
        saved.Add(new Entry { Volume = volume, Original = current, Id = IdOf(control) });
        volume.SetMasterVolume(target, ref context);
      } catch { }
    }
    return saved.Count;
  }

  public void Restore() {
    foreach (var entry in saved) {
      // An app that quit while ducked leaves a dead session here; its volume
      // died with it, so failing to restore is the correct outcome.
      try { entry.Volume.SetMasterVolume(entry.Original, ref context); } catch { }
    }
    saved.Clear();
  }
}

}
'@
} catch {
  Emit @{ event = 'status'; state = 'error'; detail = $_.Exception.Message }
  exit 1
}

$ducker = New-Object ScreenPrompt.Ducker

# The originals live on disk as well as in memory, because in memory they die
# with this process. The `finally` below covers a clean stop and a closed stdin,
# but not a kill, a crash, or the machine being switched off mid-recording — and
# Windows persists a session's volume, so without this the ducked value silently
# becomes that application's new normal, and every later recording multiplies it
# down again.
$stateDir = Join-Path $env:APPDATA 'Screen Prompt 2'
$stateFile = Join-Path $stateDir 'duck-state.json'

function Save-State {
  try {
    if ($ducker.Saved.Count -eq 0) { Remove-State; return }
    if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
    $rows = @($ducker.Saved | ForEach-Object { @{ id = $_.Id; original = $_.Original } })
    # -Depth so the hashtables are written out rather than stringified.
    ConvertTo-Json -InputObject $rows -Depth 3 -Compress | Set-Content -Path $stateFile -Encoding UTF8
  } catch { }
}

function Remove-State {
  try { if (Test-Path $stateFile) { Remove-Item $stateFile -Force } } catch { }
}

# Recovery runs before anything else touches the volumes, so a duck arriving
# immediately afterwards reads true originals rather than yesterday's ducked
# ones. The file is removed either way: a state file that cannot be applied is
# worse than none, because it would be retried on every launch forever.
$recovered = 0
try {
  if (Test-Path $stateFile) {
    # Called as a function, not piped. In a pipeline ConvertFrom-Json hands the
    # whole array down as one object, so `$_.id` inside a ForEach-Object member-
    # enumerates into an Object[] instead of yielding one row at a time — which
    # fails at the cast with a message that names neither the file nor the cause.
    $prev = ConvertFrom-Json -InputObject (Get-Content $stateFile -Raw)
    $ids = New-Object 'System.Collections.Generic.List[string]'
    $vals = New-Object 'System.Collections.Generic.List[single]'
    foreach ($row in $prev) {
      if ($null -eq $row -or [string]::IsNullOrEmpty([string]$row.id)) { continue }
      $ids.Add([string]$row.id)
      $vals.Add([single]$row.original)
    }
    if ($ids.Count -gt 0) {
      $recovered = $ducker.RestoreFrom($ids.ToArray(), $vals.ToArray())
    }
  }
} catch {
  Emit @{ event = 'error'; detail = "Could not recover volumes: $($_.Exception.Message)" }
} finally {
  Remove-State
}

Emit @{ event = 'status'; state = 'ready'; recovered = $recovered }

try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $line = $line.Trim()
    if (-not $line) { continue }
    try { $req = $line | ConvertFrom-Json } catch { continue }

    try {
      if ($req.cmd -eq 'duck') {
        # Our own tones play through a Chromium audio-service child process,
        # not the main one, so the whole process tree has to be exempt — they
        # all run the same executable, so resolving by name catches them.
        $skip = @()
        if ($req.skipName) {
          $skip = @(Get-Process -Name $req.skipName -ErrorAction SilentlyContinue |
                    ForEach-Object { [uint32]$_.Id })
        }
        $n = $ducker.Duck([float]$req.level, [uint32[]]$skip)
        # Written before acknowledging: if this process dies in the next
        # instant, the file is what puts the volumes back.
        Save-State
        Emit @{ event = 'ducked'; sessions = $n }
      } elseif ($req.cmd -eq 'restore') {
        $ducker.Restore()
        Remove-State
        Emit @{ event = 'restored' }
      }
    } catch {
      Emit @{ event = 'error'; detail = $_.Exception.Message }
    }
  }
} finally {
  try { $ducker.Restore() } catch { }
  Remove-State
}
