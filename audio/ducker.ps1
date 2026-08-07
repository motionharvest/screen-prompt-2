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

  class Entry {
    public ISimpleAudioVolume Volume;
    public float Original;
  }

  // Holding the ISimpleAudioVolume references (rather than re-enumerating and
  // matching by session id on the way back) is what makes restore exact: the
  // object we put back is the one we turned down, even if the session list has
  // changed shape in between.
  List<Entry> saved = new List<Entry>();

  public int Duck(float level, uint[] skipPids) {
    Restore();
    var skip = new HashSet<uint>(skipPids ?? new uint[0]);

    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice device;
    if (enumerator.GetDefaultAudioEndpoint(ERender, EConsole, out device) != 0 || device == null)
      return 0;

    Guid iid = typeof(IAudioSessionManager2).GUID;
    object managerObj;
    if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out managerObj) != 0 || managerObj == null)
      return 0;

    IAudioSessionEnumerator sessions;
    if (((IAudioSessionManager2)managerObj).GetSessionEnumerator(out sessions) != 0)
      return 0;

    int count;
    if (sessions.GetCount(out count) != 0) return 0;

    for (int i = 0; i < count; i++) {
      object sessionObj;
      if (sessions.GetSession(i, out sessionObj) != 0 || sessionObj == null) continue;
      try {
        var control = (IAudioSessionControl2)sessionObj;

        int state;
        if (control.GetState(out state) == 0 && state == SessionExpired) continue;
        // S_OK means this IS the system sounds session; leave Windows' own
        // blips alone, they are too short to talk over.
        if (control.IsSystemSoundsSession() == 0) continue;

        uint pid;
        if (control.GetProcessId(out pid) == 0 && skip.Contains(pid)) continue;

        // Inactive sessions are ducked too, so an app that starts playing
        // midway through a recording comes in already quiet.
        var volume = (ISimpleAudioVolume)sessionObj;
        float current;
        if (volume.GetMasterVolume(out current) != 0) continue;
        if (volume.SetMasterVolume(current * level, ref context) != 0) continue;
        saved.Add(new Entry { Volume = volume, Original = current });
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
Emit @{ event = 'status'; state = 'ready' }

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
        Emit @{ event = 'ducked'; sessions = $n }
      } elseif ($req.cmd -eq 'restore') {
        $ducker.Restore()
        Emit @{ event = 'restored' }
      }
    } catch {
      Emit @{ event = 'error'; detail = $_.Exception.Message }
    }
  }
} finally {
  try { $ducker.Restore() } catch { }
}
