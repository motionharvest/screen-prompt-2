# Screen Prompt 2

Push-to-talk dictation for Windows, macOS and Linux. Press a shortcut, talk,
and the words land in whatever app you were typing in. Transcription is local
NVIDIA **Parakeet TDT 0.6B v2** by default, so nothing leaves your machine, or
Mistral **Voxtral Mini Transcribe V2** in the cloud when you choose that and
enter a Mistral API key.

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
- **Escape cancels** — pressed while recording, the audio is thrown away and
  nothing is transcribed. Pressed while it is already transcribing, the model
  cannot be interrupted, so its answer is discarded instead: either way nothing
  is pasted, typed or put on the clipboard. Escape does nothing special when
  the app is idle.
- **Starts listening instantly** — the microphone is held open between
  recordings (a toggle, on by default), so the shortcut begins capturing in the
  same frame instead of waiting ~230 ms for an audio device to open. See
  [Latency](#latency).
- **Paste, type, or copy** — three ways for the words to arrive:
  - **Paste** copies and then pastes into the active app. Optionally puts the
    previous clipboard contents back afterwards, so dictating does not cost you
    whatever you had copied.
  - **Type** enters the text as keystrokes and never touches the clipboard at
    all. Slower for long transcripts, and some editors will autocomplete over
    it, but nothing you had copied is disturbed.
  - **Copy only** leaves it on the clipboard for you to paste yourself.
- **Overlay** — a small always-on-top pill with a live waveform line while you
  speak; it never steals focus. The line is the old spectrum bars joined into
  one contour, with a per-band visual noise gate that learns your microphone's
  background level, so silence reads flat and the swings are just your voice.
  While recording it sits at the bottom of whichever monitor the mouse is on,
  and follows if you cross to another one — until you **drag it somewhere of
  your own**, which pins it there for good. It can also be **kept on screen**
  between dictations, resting as a small outline you can grab at any time. See
  [Where the pill sits](#where-the-pill-sits).
- **Local or cloud** — Parakeet v2 on this machine by default, or Mistral
  Voxtral Mini Transcribe V2 when you enter an API key. Cloud does not start
  the local sidecar.
- **Tidy transcripts** — optional (on by default): drops “um” and “uh”,
  collapses stutters (`I I I'm` → `I'm`, `the the` → `the`) and abandoned
  restarts (`I d I don't know` → `I don't know`), squeezes out the blank runs,
  and fixes up the punctuation and capitals the edit leaves behind. Words that
  genuinely double — *had had*, *that that*, *very very*, *no no* — are left
  alone. `npm test` covers it, including the false positives a looser rule
  would cause (`the theme`, `so something`).
- **Dictionary** — the words the model cannot know. Say “clawed”, spell it
  `Claude`, and every transcript from then on says Claude. Whole words and
  phrases, case ignored when listening, replacement spelled exactly as you
  wrote it. See [Dictionary](#dictionary).
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

Requires **Node 18+**. Local transcription also needs **Python 3.10+ with
`venv` and `pip`**. The local model runs in a Python sidecar, so Python is
required unless you transcribe only in the cloud — and most Linux distributions
package `venv` and `pip` separately from the base `python3`, which is the usual
reason setup stops:

```sh
sudo apt install python3-venv python3-pip     # Debian, Ubuntu
sudo dnf install python3-pip                  # Fedora
sudo pacman -S python-pip                     # Arch
```

`install.sh` checks for both and prints the right command for your distribution
rather than letting pip fail later with something less obvious.

Setup downloads two large things: Electron's ~100 MB binary (fetched during
`npm run setup`, because Electron 43 otherwise pulls it lazily on first launch)
and the ~600 MB quantized model, on first launch.

**If the app says the Python environment is incomplete**, `npm run setup` did not
finish — most often because `venv` or `pip` was missing at the time. Install the
packages above and re-run it; setup now verifies the imports before claiming
success, so it fails at install time rather than at first launch. To start over
cleanly:

```sh
rm -rf .venv && npm run setup
```

```sh
npm install
npm run setup     # creates .venv and installs onnx-asr
npm start
```

`npm run setup` runs `install.ps1` on Windows and `install.sh` elsewhere. The
quantized model (~600 MB) downloads into the Hugging Face cache on first
launch; the status dot in the settings window turns green when it is ready.

### Starting it without a terminal (Windows)

`npm start` ties the app to a terminal that has to stay open for the whole
session. Setup also builds **`Screen Prompt 2.exe`** in the repo root: a 7 KB
stub that starts the app, exits, and leaves it running in the tray. Double-click
it, or right-click → *Pin to taskbar* / *Send to* → *Desktop* for a shortcut.
Rebuild it any time with `npm run launcher`.

It is a launcher, not a packaged build — the app still runs from this checkout,
so `git pull` updates it and nothing has to be reinstalled. Keep the exe in the
repo root; it finds Electron relative to itself. See
[`launcher/README.md`](launcher/README.md). To have it start by itself at login,
use **Start with Windows** in the settings window rather than a Startup-folder
shortcut — it registers the same launch with `--hidden`, straight into the tray.

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
| Type mode | ✅ | ✅ needs Accessibility | ✅ with a helper installed |
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

## Latency

Two things used to sit between pressing the shortcut and the first sample being
recorded. Neither was a deliberate delay, and there is no fade-in or animation
gating capture — the overlay's only transition is on its border colour.

**Opening the microphone: ~230 ms, measured.** `getUserMedia` negotiates with
the OS, the `AudioContext` opens a device at 16 kHz, and the capture worklet is
fetched and compiled. All of it ran *after* the pill already said “Listening…”,
so the first word was routinely lost. **Keep the microphone ready** (Recording
settings, on by default) does this once at launch and leaves the device open, so
starting a recording is a flag flip. The cost is that your OS shows the
microphone as in use for as long as the app runs; turn it off to go back to
opening the device per recording.

**Waiting for the key release: ~120 ms.** Every shortcut now fires on the key
press. For a combination (`Ctrl+Alt+D`) or a function key that was always true.
For a *lone modifier* it is a deliberate trade: Right Ctrl is also the Ctrl of
Ctrl+C, so at the moment it goes down there is genuinely no way to tell a
dictation tap from the start of a combination.

Waiting for the release would settle that question, at the cost of the delay
above on every single dictation. Instead the recording starts immediately and is
**silently abandoned** if another key arrives while the modifier is still held —
no tone, no message, the overlay simply never settles. The cost lands on the
rare case rather than the common one.

What this means in practice: if you press Right Ctrl and then another key, a
recording briefly started and was thrown away, and you will hear the start tone.
Use the *left* Ctrl for combinations (which is what most people already do) and
nothing collides. If you would rather not have the trade at all, hold mode and
combination shortcuts do not make this bet.

A 150 ms rolling buffer of already-heard audio still seeds each recording, now
only to absorb the few milliseconds between the hook and the renderer under
load. `npm test` covers the matcher rules, including the abort.

**The model is not on this path.** The transcriber is a separate process that
loads Parakeet once at launch and stays resident, so it is already “warm” — it
only affects how long the text takes to come back *after* you stop talking, not
how quickly recording starts.

## Architecture

Electron shell + Python sidecar:

| Piece | Where | Why |
| --- | --- | --- |
| GUI, tray, state machine | Electron main (`main.js`) | windows, clipboard, settings |
| Global shortcut | `uiohook-napi` in main | raw key-down/up events, so hold-to-record and lone-modifier shortcuts work — Electron's own `globalShortcut` can't do either |
| Mic capture, spectrum, tones | overlay renderer (Web Audio) | records straight at 16 kHz mono, `AnalyserNode` drives the waveform line |
| Transcription | `asr/server.py` (onnx-asr) or Mistral `/v1/audio/transcriptions` | Local: Parakeet TDT 0.6B v2 + Silero VAD for recordings over ~25 s (VAD skippable via “Skip chunking” for speed). Cloud: Voxtral Mini Transcribe V2. The sidecar starts only in local mode. |
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
| typing text | `type-text.ps1` (SendInput) | `osascript` | the same three, `type` |
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

The transcript history is `history.json` in the same directory. See
[History](#history).

Both files are protected against the one accident that loses them. A UTF-8
byte-order mark is stripped on read, because `JSON.parse` rejects a file that
starts with one and plenty of tools — PowerShell's `Set-Content -Encoding UTF8`
among them — write one on every save, invisibly. If a file still cannot be read
it is **not** treated as a first run: the app copies it to
`settings.json.unreadable` (or `history.json.unreadable`), starts on the
defaults, and says so in a warning at the top of the settings window, so the
next thing you change cannot overwrite it unseen. Each ordinary save also leaves
the previous contents in `settings.json.bak`, and a save made while the warning
is showing deliberately does not, since that copy would only hold the defaults.

Everything has a GUI control except `model` and `quantization` (set
`"quantization": ""` for the full-precision model — bigger download, slightly
better accuracy).

The settings window is five tabs, and they are the journey one dictation takes
rather than five bins of related switches:

| Tab | Governs | Holds |
| --- | --- | --- |
| **Recording** | what starts a dictation, and where the words go when it ends | shortcut, toggle or hold, paste / type / copy only, restore the clipboard |
| **Processing** | what the transcript becomes before it goes anywhere | local or cloud transcription, Mistral API key, tidying, chunking, dictionary |
| **Keywords** | the words that make a dictation do something instead of becoming text | the keyword list |
| **History** | what you have already dictated | the last 30 days of transcripts, click to copy |
| **App** | how the app behaves and announces itself, rather than any one dictation | colours, sounds, keeping the pill on screen and where it sits, keep the mic ready, duck other audio, start at login |

Every setting belongs to exactly one stage of that journey, which is what makes
the placement decidable rather than a matter of taste; where a tab holds several
cards they run in the order the work does, so Processing reads provider →
tidy → dictionary, the same order `handleAudio` applies them, and Keywords is
the step after both. Keywords earns a tab of its own rather than a card because it is the
list that grows: every other card is a fixed handful of switches, while that one
is however many keywords you have come to rely on, two rows each. The status
line and any platform warnings sit above the tabs, on all of them: whether the
app works at all is not a section of the settings.

**Start at login** points the login item at this checkout, so moving or
renaming the directory breaks the entry — toggle it off and on again after a
move. The OS, not the settings file, is the source of truth for the toggle's
state, so disabling it in Task Manager's Startup tab (or macOS's Login Items)
is reflected in the GUI.

## Where the pill sits

By default the pill follows you: it appears at the bottom of whichever monitor
the mouse is on, and moves if you cross to another one mid-recording. When it
is in the way, **drag it**. Grab it while it is on screen, drop it where you
want it, and it stays there — on that monitor, at that spot, for every
recording after.

**Keep it on screen** (App → The pill) leaves it there between dictations,
resting as a 50 × 10 outline: no level, no wording, nothing to read. It is
enough to see where the pill lives and to get hold of it without having to start
a recording first. Hovering brightens it and lets you drag it; talking opens it
to full size. It grows upward and outward from the mark, so the pill arrives
where you were already looking, and a spot chosen while resting is the same spot
when it opens — one position is stored, and both shapes are worked out from it.

The window never changes size — it is always the full pill's rectangle, and only
what is drawn inside it changes. That is what makes the mark and the pill share
a lower edge and a centre line on every monitor: they are the same box, and the
alignment is a fact about the window rather than a sum that has to come out
right. While resting, only the mark and a little around it takes the pointer, so
the transparent remainder of the window is not quietly eating clicks meant for
whatever is behind it.

This replaced a version that resized the window between the two shapes, and the
reason is worth recording. The smallest window Windows will create is a fixed
number of *physical* pixels — measured here at 56 — which is 38 logical pixels
on a 150% display but 56 on a 100% one. A 40-tall resting window was therefore
granted 40 on one monitor and 56 on the other, and since the extra height is
added below, the mark sat exactly 16 logical pixels lower than the pill it was
supposed to line up with, on that monitor only.

Dragging is what turns the following off. There is no mode to enter first: the
gesture *is* the instruction, and **App → Overlay position** shows the switch it
flipped. Turning that switch back on forgets the pinned spot and returns the
pill to the bottom of the screen you are working on.

Two details worth knowing. The pill is click-through, so it never swallows a
click meant for the window underneath — except while the pointer is actually
over it, which is the moment you are reaching for it anyway. And a pinned spot
is pulled back onto the nearest screen if the monitor it was pinned to is
unplugged or rearranged, so it cannot strand itself off the desktop.

## History

Every transcript is kept for **30 days**, newest first, on the History tab.
Clicking one puts it back on the clipboard. It is stored beside the settings —
`history.json` in the same directory — rather than inside them, because settings
are rewritten every time you touch a switch and a month of dictation has no
business riding along with them.

History is stored on this machine only. Local transcription makes the same
promise for the audio; cloud transcription sends the recording to Mistral.
What changed is that transcripts now reach the disk rather than living only
in memory, so **Clear history** deletes the file outright, and the button
asks a second time before it does.

Retention is enforced on the way in and on the way out: entries older than 30
days are dropped whenever the file is read and whenever a transcript is added,
and the list is capped at 2000 entries so a very heavy month cannot grow it
without bound. `npm test` covers the retention, the ordering and the cap.

## Dictionary

Parakeet spells what it hears, and it has never seen your colleague's name or
the product you talk about all day. The dictionary is two columns — what it
hears on the left, how it should be spelled on the right — applied to every
transcript before the words go anywhere.

| Heard | Spelled |
| --- | --- |
| `clawed` | `Claude` |
| `clawed code` | `Claude Code` |
| `iphone` | `iPhone` |
| `definately` | `definitely` |
| `dot com` | `.com` |

The rules, all of which `npm test` covers:

- **Whole words only.** `clawed` never fires inside `declawed`, and an entry
  may be several words — “clawed code” is one entry, and beats the shorter
  `clawed` wherever both could match.
- **Case is ignored when listening**, so one entry covers “clawed”, “Clawed”
  and “CLAWED”.
- **The spelling is used exactly as you wrote it**, so `iPhone` keeps its small
  i even at the start of a sentence. The one exception is a spelling with no
  capitals of its own: it takes a capital where the word it replaced had one,
  which is what makes `definately` → `Definitely` work after a full stop.
- **One pass, left to right.** A replacement is never fed back through the
  other entries, so `alpha`→`beta` and `beta`→`gamma` cannot chain into
  `gamma`, and the order of the rows never changes the result.
- **A spelling starting with `,` `.` `;` `:` `!` or `?` takes the space with
  it**, so “example dot com” becomes `example.com` rather than `example .com`.
- **Both halves or nothing.** A row with one side still empty is one you are in
  the middle of typing; it is saved, and it never matches.

The dictionary runs after the tidying and before the keywords, so a stutter is
collapsed before it is looked up, and a keyword still fires when the model
misheard its name.

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
- Escape is observed rather than swallowed, like the shortcut itself, so the
  focused app still receives it. It is only acted on while recording or
  transcribing, so closing a dialog with Escape the rest of the time is
  unaffected.
- Closing the settings window keeps the app in the tray; quit from the tray
  menu.
- Clicking any row in **History** copies that transcript back to the clipboard —
  useful once something else has overwritten it, or once you want back something
  you dictated last week.
- Ducking restores volumes when the helper's stdin closes, so quitting the app
  mid-recording still puts the rest of the system back. It skips desktop event
  sounds and every process sharing this app's executable name (Chromium plays
  our tones from a child process, not the main one).
- A helper that is *killed* rather than closed cannot restore anything, and
  both Windows and PulseAudio remember a volume once it is set — so the ducked
  value would quietly become that application's normal volume, and the next
  recording would duck it again from there. The originals are therefore written
  to `duck-state.json` next to the settings file for as long as anything is
  ducked, and recovered on the next launch before anything else touches the
  volumes. Two backstops sit behind that: nothing already at or below the duck
  level is ducked again, and nothing is ever set below 2%.
- If auto-paste is unavailable, the transcript is still on the clipboard —
  the feature degrades to "paste it yourself" rather than losing text. Type
  mode falls back the same way: a dirty clipboard beats a transcript that went
  nowhere.
- Typing uses `SendInput` with `KEYEVENTF_UNICODE` on Windows rather than
  `SendKeys`, because SendKeys resolves each character through the current
  keyboard layout and silently drops exactly the curly apostrophes and em
  dashes the tidying leaves behind. The helper is kept running between
  transcripts: starting it costs ~400 ms, a line once warm costs ~5 ms.
- Restoring the clipboard waits 400 ms after the paste before putting the old
  contents back. `Ctrl+V` returns immediately and the application reads the
  clipboard later on its own thread, with no event to wait for — restore too
  soon and the paste lands empty. Text, formatting and images are preserved;
  copied *files* cannot be, so a clipboard holding files is left holding the
  transcript instead.

## Licence

MIT — see [LICENSE](LICENSE).
