# Screen Prompt 2

Push-to-talk dictation for Windows, macOS and Linux. Press a shortcut, talk,
and the words land in whatever app you were typing in. Transcription is local
NVIDIA **Parakeet TDT 0.6B v2** by default, so nothing leaves your machine, or
NVIDIA **Nemotron 3.5 ASR Streaming 0.6B** locally (needs the `nemo-speech`
CLI), or a cloud model when you choose that and enter its API key: Mistral
**Voxtral Mini Transcribe V2**, or Modulate **multilingual** (fast by default,
or streaming / full).

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
    whatever you had copied, and optionally presses **Enter** once the paste has
    landed, so a chat box or a message field sends itself.
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
- **Local or cloud** — Parakeet v2 on this machine by default, or Nemotron 3.5
  streaming locally (same live-PCM path as Modulate streaming; needs NVIDIA's
  [`nemo-speech`](https://github.com/NVIDIA/NeMo-Speech.cpp#installation) CLI),
  or a cloud model when you enter its API key: Mistral Voxtral Mini Transcribe
  V2, or Modulate multilingual (fast, streaming, or full). Cloud does not start
  the local sidecar. Processing links to
  [console.mistral.ai](https://console.mistral.ai/api-keys/) and
  [platform.modulate.ai](https://platform.modulate.ai/signup-request) for a
  key.
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
- **Keywords** — describe an action in plain words, and TypeSafe's Jev model
  decides after each dictation whether you asked for it: “look up the capital
  of Indiana” opens the search instead of typing the words. Each keyword opens
  a URL, runs a command, or runs a
  **keyboard macro** into whatever window you were in — a list of key
  combinations and waits, each one recorded by pressing it. `%s` marks where
  the query goes. See [Keywords](#keywords).
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

Nemotron 3.5 streaming is a second local model. It is not in the Python
sidecar: it needs NVIDIA's [`nemo-speech`](https://github.com/NVIDIA/NeMo-Speech.cpp)
CLI. The installer picks CUDA when `nvidia-smi` sees a GPU, then fails its
health check if CUDA cannot initialize (common on laptops). Install the CPU
build instead:

```powershell
irm https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.ps1 -OutFile $env:TEMP\install-nemo-speech.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\install-nemo-speech.ps1 -Backend cpu
```

On Linux or macOS:

```sh
curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh -s -- --backend cpu
```

Open a new terminal after that, quit the tray app, and pick Nemotron on the
Processing tab. First use downloads the GGUF. Screen Prompt 2 starts
`nemo-speech serve` with `--device cpu`.

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
| Keyboard-macro keyword | ✅ | ✅ needs Accessibility | ✅ needs wtype or xdotool |
| Keys held back while recording one | ✅ | ❌ records, but the keys also act | ❌ records, but the keys also act |
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
| Transcription | `asr/server.py` (onnx-asr), `nemo-speech serve`, or a cloud POST | Local Parakeet TDT 0.6B v2 + Silero VAD for recordings over ~25 s (VAD skippable via “Skip chunking” for speed). Local Nemotron 3.5 ASR Streaming 0.6B via NVIDIA's `nemo-speech` CLI (`ws://127.0.0.1:18765/v1/audio/transcriptions/realtime`, 16 kHz PCM while you talk). Cloud: Mistral Voxtral Mini Transcribe V2 (`/v1/audio/transcriptions`) or Modulate multilingual — fast batch (`/api/velma-2-stt-batch-multilingual-vfast`, the default), live streaming (`/api/velma-2-stt-streaming-multilingual-vfast`), or full batch (`/api/velma-2-stt-batch`). Python sidecar starts only for local Parakeet. |
| Cursor trail | one window per monitor (`renderer/trail.js`) | transparent, click-through, fed the cursor's position from main so each monitor's canvas gets its own coordinates at its own scale — see [The cursor trail](#the-cursor-trail) |
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

The transcript history is `history.json` in the same directory, and the year of
daily totals is `stats.json`. See [History](#history).

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

The settings window is a sidebar of five sections, and they are the journey one
dictation takes rather than five bins of related switches:

| Tab | Governs | Holds |
| --- | --- | --- |
| **Recording** | what starts a dictation, and where the words go when it ends | shortcut, toggle or hold, paste / type / copy only, restore the clipboard, press Enter after pasting |
| **Processing** | what the transcript becomes before it goes anywhere | one engine picker (Parakeet or Nemotron on this device, Mistral or Modulate in the cloud) with that engine's own controls beneath it: chunking, the install note, the API key, the Modulate mode; then tidying and the dictionary |
| **Keywords** | the words that make a dictation do something instead of becoming text | the keyword list, in named groups once you make them |
| **History** | what you have already dictated | words, words per minute, tidy/dictionary fixes, a year of days, the last 30 days of transcripts |
| **App** | how the app behaves and announces itself, rather than any one dictation | colours, sounds, keeping the pill on screen and where it sits, the cursor trail, keep the mic ready, duck other audio, start at login |

Every setting belongs to exactly one stage of that journey, which is what makes
the placement decidable rather than a matter of taste; where a tab holds several
cards they run in the order the work does, so Processing reads provider →
tidy → dictionary, the same order `handleAudio` applies them, and Keywords is
the step after both. Keywords earns a tab of its own rather than a card because it is the
list that grows: every other card is a fixed handful of switches, while that one
is however many keywords you have come to rely on. The status line sits in the
sidebar under the app's name, on every section, and any platform warnings sit
at the top of the content: whether the app works at all is not a section of
the settings. The engine's own state is repeated inside the Processing card,
next to the choice that governs it. The colour scheme chosen on the App
section restyles this window as well as the pill.

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

## The cursor trail

**App → Cursor trail** draws the last stretch of the cursor's path behind it
for as long as the app is listening, in the same two colours the pill's
spectrum uses: the bright one at the cursor, shading to the darker one as the
line runs out. It is the pill's readout a second time, put where you are
already looking rather than at the edge of the screen — useful when the pill is
on another monitor, or parked somewhere you are not watching.

**Length** is how many pixels of path are kept, from 150 to 2000, and 650 by
default. It is measured *along the line*, not as a distance from the cursor, so
a loop or a scribble costs what it actually drew. The line tapers and fades
toward its far end, and when you stop talking the whole thing fades out over
about four tenths of a second rather than vanishing between two frames.

It is off by default, because it draws over every window you own.

Three things about how it is built are worth knowing, because they are what
make it safe to leave on. It is one transparent window per monitor, each the
size of that monitor, rather than one window over the whole desktop: a window
spanning two displays has a single scale factor, so half of it would be drawn
at the wrong size, and an L-shaped arrangement of screens has a bounding box
with a hole in it. Every one of those windows is click-through and never
focusable, and unlike the pill it never asks for the clicks back — so it cannot
swallow one, and it cannot take your keyboard focus away from whatever you are
dictating into. And the cursor is read from the OS in the main process rather
than from mouse events in those windows, which is what lets a point be handed
to the right monitor's canvas in that monitor's own coordinates, on a desktop
where each screen is scaled differently.

The windows are made the first time you record with the setting on, and thrown
away when you switch it off. Crossing between monitors mid-sentence leaves the
line you drew on the one you left to run out on its own, which is what that
should look like.

## History

Every transcript is kept for **30 days**, newest first, on the History tab.
Clicking one puts it back on the clipboard. Above the list: how many words you
have dictated, words per minute, and how many tidy/dictionary fixes landed
between what the model said and what was delivered. A year of days sits under
that — Sunday to Saturday down, months across — darker amber for a heavier day.

Transcripts are `history.json` beside the settings; daily totals are
`stats.json`, which outlive the thirty-day list so the grid does not go blank
when a transcript ages out. Settings are rewritten every time you touch a
switch and a month of dictation has no business riding along with them.

History is stored on this machine only. Local transcription makes the same
promise for the audio; cloud transcription sends the recording to Mistral or
Modulate, depending on the model you picked.
**Clear history** deletes both files outright, and the button asks a second
time before it does.

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
collapsed before it is looked up, and Jev reads the corrected words.

## Keywords

A keyword is a description of what it does, such as “Searches Google for
whatever the user asks about” or “Changes the current model inside Claude Code
to Fable”. After every dictation the transcript and the descriptions go to
TypeSafe's Jev model in one request, which asks two things. The first is
whether you were dictating text or asking for one of the described actions.
The second picks the words the action should act on, chosen from the stretches
of what you said that run to its end, so “please search for tacos” gives the
query “tacos”. An action runs only when Jev gives it a probability of at least
0.6; anything less is typed as dictation. When a keyword fires the text is not
copied or pasted: the words were an instruction, not something to type.

Keywords need a TypeSafe API key, entered at the top of the Keywords tab. With
no key, or no keywords, nothing is sent and every dictation is typed. If the
request fails, the dictation is typed and the overlay says why keywords did not
run. A keyword saved by an older version, which only had a spoken word, is read
as the description “The user says ‘word’” until you rewrite it.

| Type | Target | Result of “Google, capital of Indiana” |
| --- | --- | --- |
| Open a URL | `https://www.google.com/search?q=%s` | opens that search in your browser |
| Open a URL | `https://www.google.com/search?q=` | same — with no `%s` the query is appended |
| Run a command | `notepad.exe %s` | runs notepad with one argument, `capital of Indiana` |
| Run a macro | `ctrl+c 400ms ctrl+v` | runs that keyboard macro; the rest of the sentence is ignored |

Commands run **without a shell**, so nothing you say can be read as a shell
operator — the query is passed as a single argument whatever is in it. That
also means:

- Pipes, redirects and `$variables` do not work. Point the target at
  `cmd /c …`, `sh -c …` or `powershell -Command …` yourself if you want them —
  but note that pasting the query into a script's *source* is exactly what the
  no-shell design avoids, and a spoken apostrophe is enough to break it.
- The target is split on spaces, honouring `"quotes"` one level deep. Nested
  quotes are not parsed; put anything complicated in a script file instead.

### Groups

A long keyword list reads better in named groups, so the Keywords section
holds them under headings. **New group** makes an empty one; drag a keyword by
the handle at its left into any group, or up and down inside the one it is
already in; the **+** on a group's right adds a new keyword straight into it.
A heading folds its keywords away while you work somewhere else, and removing a
group hands its keywords back to *Ungrouped* rather than deleting them.

Grouping is a way of reading the list and nothing else. Matching looks at every
keyword whatever group it is in, so moving one changes where it sits in this
window and not what it does. The group is stored on the keyword as `group`, and
the headings themselves — including one you have made but not filled yet — are
`keywordGroups` in the settings file.

### Keyboard macros

A *Run a macro* keyword works the keyboard of whatever window has the caret —
the same window a transcript would have been typed into. Say “Palette” and
Ctrl+Shift+P opens the command palette in front of you.

**Record a press by pressing it.** The keyword starts as a single target field
like any other. Click it and it begins recording; press the combination and it
appears there. **Esc** throws the recording away and keeps what was there
before, and clicking the field again records over it.

**The + beside the delete grows it into a macro**: a numbered list run in
order, with the press you already recorded as the first of them. The + adds
nothing by itself — it opens the two kinds of step underneath, and whichever
you pick is inserted after it. Every step then carries a + of its own, so
press, wait, press is built in the order it runs rather than assembled and
rearranged.

Which shape you see follows the macro rather than a setting, so deleting your
way back down to one press returns it to a single field.

A step is either a key combination or a wait. **A wait is for where the next
key has to land after something has happened** — a menu opening, a window
coming up, a page loading. Two presses with nothing between them still get a
few milliseconds, because keys sent in the same instant can be missed by
anything that reads the keyboard by polling.

Steps are removed with the × beside them. There is no way to move one, so
changing the order means deleting and re-inserting.

The longest single wait is 10 seconds and a macro can have 32 steps. While a
macro runs the app is busy with it and you cannot dictate, which is the reason
for both bounds.

**On Windows the keys are held back from everything else while you record**, so
pressing Win+D records `meta+d` instead of showing your desktop, and Alt+Tab
records instead of switching windows. Ctrl+Alt+Del and Win+L are the
exceptions: Windows handles those below where any application can reach. The
same holding applies to recording the push-to-talk shortcut. Because the
keyboard is held, clicking is the way out of the field — Tab is a key like any
other while a recording is running.

This needs a hook that the rest of the system consults before its own
shortcuts, which is a Windows-only helper; see
[How the keys are held back](#how-the-keys-are-held-back). On macOS and Linux
the recording works but the keys are not held, so a combination your desktop
already uses will do its usual thing as well as being recorded. The settings
window says which of the two you have.

The whole macro is stored as one line of text, which is what the settings file
holds and what you can edit there by hand: steps separated by spaces, modifiers
first joined with `+`, a wait written as a number of milliseconds.

| Target | What it runs |
| --- | --- |
| `ctrl+shift+p` | Ctrl, Shift and P together |
| `f5` | F5 on its own — a bare key is fine here |
| `alt+arrowleft` | Alt and the left arrow |
| `ctrl+k ctrl+d` | two combinations in a row, the way editors bind them |
| `ctrl+c 400ms ctrl+v` | copy, wait four tenths of a second, paste |
| `500ms enter` | wait half a second, then press Enter |

Modifiers are `ctrl`, `alt`, `shift` and `meta` (the Windows or Command key).
Everything else is the key's own name, lowercased — `enter`, `tab`, `escape`,
`space`, `backspace`, `delete`, `home`, `end`, `pageup`, `pagedown`,
`arrowup`/`arrowdown`/`arrowleft`/`arrowright`, `f1` to `f24`, `numpad0` to
`numpad9`, and the punctuation keys under the names `comma`, `period`,
`slash`, `semicolon`, `quote`, `backquote`, `minus`, `equal`, `backslash`,
`bracketleft` and `bracketright`.

A step that cannot be read stops the whole macro rather than part of it, and
the overlay says so. Half a macro run into someone's editor is worse than a
refusal.

Two things this deliberately does not do. **The rest of the sentence is
ignored**: a macro has nothing to do with a query, so “Copy that” runs the
macro and drops “that”. And **Esc cannot be recorded**, because Esc is what
cancels the recording; type `escape` into the settings file by hand if you need
it.

The recording is read from the same uiohook stream the global shortcut is read
from, so the key that is stored is the key you pressed. How it is sent again
differs by platform, because each one offers a different way in: Windows sends
the scan code and lets the current layout say which virtual key that is, Linux
hands wtype or xdotool an X keysym, and macOS asks System Events for the
character where there is one and for the key position where there is not. On a
single-layout keyboard these are the same key; if you switch layouts, expect
the letter keys to follow the layout rather than the position.

On Linux this needs **wtype** (Wayland) or **xdotool** (X11). ydotool, which is
enough for pasting, names keys by raw event code rather than by name and cannot
send a combination; the settings window says so when that is what it found.

### How the keys are held back

The hook the app already listens to, uiohook, *observes* the keyboard: every
key it reports has already been delivered to whoever it was going to. That is
right for a push-to-talk shortcut and wrong for recording one, because Win+D
reaches the shell and shows the desktop before the recorder hears about it at
all. The only thing on Windows that runs ahead of the shell's own hotkeys is a
`WH_KEYBOARD_LL` hook that answers “hallo, handled”, and that needs a process
with a message pump — which is what `grab-keys.ps1` is. It is kept warm for the
same reason the typing helper is: compiling the hook costs most of a second,
and paying that after the click is exactly when the first keys would escape.
The hook itself only exists between one recording and the next.

A keyboard nobody can type on is much worse than a recording that stopped, so
it lets go on every path out: when the field loses focus, when you switch to
another application, when the settings window is hidden or closed, when the app
quits, and when the helper's own stdin closes because the app is gone. Failing
all of those it drops the hook by itself after two minutes. Keys the app itself
sent are passed through rather than swallowed, so a recording can never capture
what a keyword had just pressed.

**Launching apps** is the common case, so a launcher ships with it. Add a
keyword of type *Run a command* described as starting an application the user
names, and “Launch Spotify” starts Spotify:

```sh
# Windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<this directory>\launch-app.ps1" %s

# macOS and Linux
<this directory>/launch-app.sh %s
```

The settings window adds the right one for your machine with **Add the app
launcher** on the Keywords tab, and **How a command runs** there explains the
rules above. Both scripts take the spoken
name as bound arguments rather than interpolating it into a command string, so
nothing you say is ever parsed as shell. Both match on a partial name with the
shortest match winning, so “Launch Word” prefers Word over WordPad.

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
- Pressing Enter after a paste waits 250 ms first, for the same reason and from
  the other side: `Ctrl+V` returns before the application has read the
  clipboard, and an Enter that arrives first sends an empty box. It is sent
  through the same key-combination helper the `keys` keywords use, so where that
  is unavailable — Linux with no `wtype` or `xdotool` — the text is pasted and
  left unsent rather than the delivery failing.

## Licence

MIT — see [LICENSE](LICENSE).
