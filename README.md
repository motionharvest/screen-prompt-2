# Screen Prompt 2

Push-to-talk dictation for Windows, macOS and Linux. Press a shortcut, talk,
and the words land in whatever app you were typing in — transcribed locally by
NVIDIA **Parakeet TDT 0.6B v2**, so nothing leaves your machine.

A deliberately simple sibling of `screen-prompt`: no gestures, no screenshots,
no figures — just voice to text.

> **Testing status.** The app is developed and run daily on Windows. The macOS
> and Linux support is written against each platform's documented behaviour and
> its individual pieces are unit-tested, but the full app has not yet been run
> end to end on either. Treat those two as "should work, please report what
> doesn't" rather than as proven. Bug reports very welcome.

## What it does

- **Global shortcut**, fully configurable from the GUI — combinations
  (`Ctrl+Alt+D`), function keys, or a lone modifier like right&nbsp;Ctrl.
- **Toggle or hold** — press to start / press to stop, or record only while
  the key is held (push-to-talk).
- **Paste or copy** — when transcription finishes the text is copied to the
  clipboard, and can optionally be pasted straight into the active app.
- **Overlay** — a small always-on-top pill with a live audio spectrum while
  you speak; it never steals focus. While recording it sits at the bottom of
  whichever monitor the mouse is on, and follows if you cross to another one.
- **Tidy transcripts** — optional (on by default): drops “um” and “uh”,
  collapses stutters (`I I I'm` → `I'm`, `the the` → `the`) and abandoned
  restarts (`I d I don't know` → `I don't know`), squeezes out the blank runs,
  and fixes up the punctuation and capitals the edit leaves behind. Words that
  genuinely double — *had had*, *that that*, *very very*, *no no* — are left
  alone. `npm test` covers it, including the false positives a looser rule
  would cause (`the theme`, `so something`).
- **Keywords** — say a keyword first and the rest of the sentence becomes a
  query: “Google, what is the capital of Indiana” opens the search instead of
  typing the words. Each keyword opens a URL or runs a command, with `%s`
  marking where the query goes.
- **Colour schemes** — the overlay ships with the default warm amber and a
  **Synthwave** scheme (neon blue and pink bars on deep purple).
- **Volume ducking** — optionally turns other audio down while you record, so
  the mic hears you rather than your speakers, by an amount you set with a
  slider.
- **Sounds** — a rising tone when recording starts, a falling one when it
  stops, and a little triad when the transcription is ready.
- **Start at login** — a toggle that registers a login item launching the app
  straight to the tray, with no window.

## Install

Requires **Node 18+** and **Python 3.10+** on every platform.

```sh
npm install
npm run setup     # creates .venv and installs onnx-asr
npm start
```

`npm run setup` runs `install.ps1` on Windows and `install.sh` elsewhere. The
quantized model (~600 MB) downloads into the Hugging Face cache on first
launch; the status dot in the settings window turns green when it is ready.

### Per-platform prerequisites

**Windows 10/11** — nothing else. Ducking and auto-paste use components that
ship with the OS.

**macOS 12+** — grant **Accessibility** permission (System Settings → Privacy
& Security → Accessibility) to whichever binary is running the app: `Electron`
for a dev checkout, `Screen Prompt 2` once packaged. Without it the global
shortcut and auto-paste both silently do nothing, which is why the settings
window checks on every launch and offers a button to request it.

**Linux** — install a paste helper for your session:

| Session | Install | Notes |
| --- | --- | --- |
| X11 | `xdotool` | Works out of the box. |
| Wayland | `wtype` | Uses the virtual-keyboard protocol. |
| Either | `ydotool` | Goes through `/dev/uinput`; needs its daemon and permissions. |

`pactl` (PulseAudio or PipeWire) is needed for volume ducking. Everything
else — the shortcut, capture, transcription, clipboard — has no extra
dependency. The settings window tells you what is missing rather than failing
quietly at the moment you first dictate.

## Platform differences

Everything works everywhere except where noted:

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Global shortcut | ✅ | ✅ needs Accessibility | ✅ X11 · ⚠️ Wayland, see below |
| Auto-paste | ✅ | ✅ needs Accessibility | ✅ with a helper installed |
| Volume ducking | ✅ per-app | ⚠️ whole output only | ✅ per-app |
| Launch-an-app keyword | ✅ Start menu | ✅ /Applications | ✅ `.desktop` entries |
| Start at login | ✅ registry | ✅ login item | ✅ XDG autostart |

**macOS ducking is all-or-nothing.** There is no public per-application volume
API on macOS — CoreAudio exposes output *device* volume, not a per-process
mixer — so the whole output is turned down and put back, and the app's own
tones are quietened with it. Windows (Core Audio sessions) and Linux
(PulseAudio sink inputs) both duck each app separately and restore each to its
own original volume.

**Wayland limits the global shortcut.** The compositor deliberately stops one
client from reading another's keystrokes, so the hook only sees keys pressed in
XWayland windows. This is Wayland working as designed, not a bug here; an X11
session gets a shortcut that works everywhere.

## Architecture

Electron shell + Python sidecar:

| Piece | Where | Why |
| --- | --- | --- |
| GUI, tray, state machine | Electron main (`main.js`) | windows, clipboard, settings |
| Global shortcut | `uiohook-napi` in main | raw key-down/up events, so hold-to-record and lone-modifier shortcuts work — Electron's own `globalShortcut` can't do either |
| Mic capture, spectrum, tones | overlay renderer (Web Audio) | records straight at 16 kHz mono, `AnalyserNode` drives the bars |
| Transcription | `asr/server.py` (onnx-asr) | Parakeet TDT 0.6B v2 + Silero VAD for recordings over ~25 s |
| Per-OS behaviour | `platform/*.js` | one adapter per platform, see below |

Electron was chosen over Tauri because the audio pipeline (capture, spectrum,
synthesized tones) all lives in one Web Audio context, and the ASR is a Python
sidecar either way — no Rust port needed.

### The platform layer

Most of the pipeline is already portable: `uiohook-napi` ships prebuilt
binaries for all three platforms, capture and tones are Web Audio, and the ASR
sidecar is plain Python. Only four things need an OS-specific answer, and they
all live in `platform/`:

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| venv interpreter | `.venv\Scripts\python.exe` | `.venv/bin/python3` | `.venv/bin/python3` |
| paste keystroke | `paste.vbs` (SendKeys) | `osascript` | `wtype` / `ydotool` / `xdotool` |
| ducking helper | `audio/ducker.ps1` | `audio/ducker.py` | `audio/ducker.py` |
| login item | registry `Run` key | `setLoginItemSettings` | `~/.config/autostart` |

Both ducking helpers speak the same JSON-lines protocol, so `main.js` starts
one and does not care which. `audio/ducker.ps1` stays PowerShell because the
Core Audio session API is COM-only; `audio/ducker.py` uses the venv interpreter
that transcription already requires, so it adds nothing to install.

Adding a platform means adding one file to `platform/` and nothing else. Each
adapter also reports a `capabilities()` object, which is how the settings
window can say "install xdotool" instead of appearing to work and then not.

## Settings

Stored next to the app's user data:

| | |
| --- | --- |
| Windows | `%APPDATA%\Screen Prompt 2\settings.json` |
| macOS | `~/Library/Application Support/Screen Prompt 2/settings.json` |
| Linux | `~/.config/Screen Prompt 2/settings.json` |

Everything has a GUI control except `model` and `quantization` (set
`"quantization": ""` for the full-precision model — bigger download, slightly
better accuracy).

**Start at login** points the login item at this checkout, so moving or
renaming the directory breaks the entry — toggle it off and on again after a
move. The OS, not the settings file, is the source of truth for the toggle's
state, so disabling it in Task Manager's Startup tab (or macOS's Login Items)
is reflected in the GUI.

## Keywords

A keyword only fires when it is the **first** thing in what you said, and only
on a word boundary — so “Google, what is …” searches, while “I asked Google
about it” and “Googleplex” are transcribed as normal. The longest matching
keyword wins, so `search youtube` beats `search`. When a keyword fires the text
is not copied or pasted: the words were an instruction, not something to type.

| Type | Target | Result of “Google, capital of Indiana” |
| --- | --- | --- |
| Open a URL | `https://www.google.com/search?q=%s` | opens that search in your browser |
| Open a URL | `https://www.google.com/search?q=` | same — with no `%s` the query is appended |
| Run a command | `notepad.exe %s` | runs notepad with one argument, `capital of Indiana` |

Commands run **without a shell**, so nothing you say can be read as a shell
operator — the query is passed as a single argument whatever is in it. That
also means:

- Pipes, redirects and `$variables` do not work. Point the target at
  `cmd /c …`, `sh -c …` or `powershell -Command …` yourself if you want them —
  but note that pasting the query into a script's *source* is exactly what the
  no-shell design avoids, and a spoken apostrophe is enough to break it.
- The target is split on spaces, honouring `"quotes"` one level deep. Nested
  quotes are not parsed; put anything complicated in a script file instead.

**Launching apps** is the common case, so a launcher ships with it. Add a
`Launch` keyword of type *Run a command* and “Launch Spotify” starts Spotify:

```sh
# Windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<this directory>\launch-app.ps1" %s

# macOS and Linux
<this directory>/launch-app.sh %s
```

The settings window shows the right one for your machine. Both take the spoken
name as bound arguments rather than interpolating it into a command string, so
nothing you say is ever parsed as shell. Both match on a partial name with the
shortest match winning, so “Launch Word” prefers Word over WordPad. Prefer
`Launch` over `Open` as the keyword: “Open the door” would be swallowed as a
failed app lookup rather than transcribed.

Where they look:

- **Windows** — `Get-StartApps`. Its AppIDs come in two kinds and need
  different launches: packaged apps get an AppUserModelID that only
  `shell:AppsFolder` resolves, while plain Win32 entries (Spotify, Python) get
  the executable's own path, which `shell:AppsFolder` silently ignores —
  explorer exits 0 having done nothing. The script tests which it has.
- **macOS** — `/Applications`, `/System/Applications` and `~/Applications`,
  two levels deep so `Utilities/` is included, then `open -a`.
- **Linux** — XDG `.desktop` entries including Flatpak exports, skipping
  `NoDisplay`/`Hidden` ones, launched with `gio launch` or `gtk-launch` (and
  falling back to parsing `Exec=` where neither exists).

A command that fails *after* it has been launched — the app-not-found case
above — reports back to the overlay for a few seconds afterwards, replacing
the success line. Without that a keyword can only ever claim it worked.

## Notes

- The shortcut is observed, not swallowed — the keystroke still reaches the
  focused app, so prefer combinations that app ignores (or a lone modifier /
  function key).
- Recordings shorter than ~0.35 s are treated as an accidental tap and
  discarded with a cancel tone.
- Closing the settings window keeps the app in the tray; quit from the tray
  menu.
- Clicking the **Last transcription** box copies it back to the clipboard —
  useful once something else has overwritten it.
- Ducking restores volumes when the helper's stdin closes, so killing the app
  mid-recording still puts the rest of the system back. It skips desktop event
  sounds and every process sharing this app's executable name (Chromium plays
  our tones from a child process, not the main one).
- If auto-paste is unavailable, the transcript is still on the clipboard —
  the feature degrades to "paste it yourself" rather than losing text.

## Licence

MIT — see [LICENSE](LICENSE).
