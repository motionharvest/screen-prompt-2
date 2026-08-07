# Types text into the foreground window as synthetic keystrokes, so a
# transcript can be entered without the clipboard ever being touched.
#
# Long-lived and fed over stdin, in the same JSON-lines style as the ASR and
# ducking helpers:
#
#     in   {"text":"hello there"}
#     out  {"event":"status","state":"ready"}   {"event":"typed","chars":11}
#
# It stays running because starting it is the expensive part: PowerShell's own
# startup plus compiling the C# below costs about 600 ms, and paying that
# between "transcribed" and "text appears" would undo the point of the feature.
# Spawned once on the first use of type mode and kept alive after that, the
# per-line cost is just the SendInput call.
#
# SendInput with KEYEVENTF_UNICODE rather than WScript.Shell's SendKeys (which
# paste.vbs uses for Ctrl+V, where it is fine). SendKeys goes through
# VkKeyScan, so it can only produce characters that exist on the current
# keyboard layout — and the tidying leaves curly apostrophes and em dashes in
# the text, which is exactly what that drops. KEYEVENTF_UNICODE takes a UTF-16
# code unit directly and bypasses the layout entirely.

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

public static class Typer {
  const uint InputKeyboard = 1;
  const uint KeyEventUnicode = 0x0004;
  const uint KeyEventKeyUp = 0x0002;
  const ushort VkReturn = 0x0D;

  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags;
    public uint time; public IntPtr dwExtraInfo;
  }

  // Declared only so the union below is sized correctly. SendInput validates
  // the struct size it is given, and MOUSEINPUT is the largest member — leave
  // it out and every call fails with "invalid parameter" on 64-bit.
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData;
    public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint count, INPUT[] inputs, int size);

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var input = new INPUT();
    input.type = InputKeyboard;
    input.u.ki.wVk = vk;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    return input;
  }

  public static uint Send(string text) {
    var inputs = new List<INPUT>();
    foreach (char c in text) {
      // A newline sent as a Unicode character does nothing useful in most
      // applications; it has to be the Return key.
      if (c == '\n') {
        inputs.Add(Key(VkReturn, 0, 0));
        inputs.Add(Key(VkReturn, 0, KeyEventKeyUp));
      } else if (c == '\r') {
        continue;                       // CRLF already handled by the \n above
      } else {
        // Surrogate pairs need no special case: each UTF-16 code unit is sent
        // as it stands and Windows reassembles them.
        inputs.Add(Key(0, c, KeyEventUnicode));
        inputs.Add(Key(0, c, KeyEventUnicode | KeyEventKeyUp));
      }
    }
    if (inputs.Count == 0) return 0;
    // One call for the whole string: the events land as an uninterruptible
    // block, so nothing typed by hand mid-way can interleave with it.
    return SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
}

}
'@
} catch {
  Emit @{ event = 'status'; state = 'error'; detail = $_.Exception.Message }
  exit 1
}

Emit @{ event = 'status'; state = 'ready' }

# Explicitly UTF-8 off the raw handle. [Console]::In decodes using the console
# code page, which mangles every non-ASCII character the model produced.
$reader = New-Object System.IO.StreamReader(
  [Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)

while ($null -ne ($line = $reader.ReadLine())) {
  if (-not $line.Trim()) { continue }
  try {
    $req = $line | ConvertFrom-Json
    $text = [string]$req.text
    if ([string]::IsNullOrEmpty($text)) { Emit @{ event = 'typed'; chars = 0 }; continue }
    $sent = [ScreenPrompt.Typer]::Send($text)
    if ($sent -eq 0) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Emit @{ event = 'error'; detail = "SendInput delivered nothing (error $code)" }
    } else {
      Emit @{ event = 'typed'; chars = $text.Length }
    }
  } catch {
    Emit @{ event = 'error'; detail = $_.Exception.Message }
  }
}
