// Screen Prompt 2 — push-to-talk dictation with local Parakeet v2.
//
// Main process owns the state machine: global shortcut (uiohook) -> overlay
// records -> wav -> Python sidecar (onnx-asr, Parakeet TDT 0.6B v2) -> text ->
// clipboard, optionally pasted into the active app.

const {
  app, BrowserWindow, ipcMain, clipboard, screen, Tray, Menu, nativeImage, session, shell,
} = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Everything this app cannot do the same way on every OS lives behind here:
// the venv layout, the paste keystroke, volume ducking and the login item.
const platform = require('./platform');

// ---------------------------------------------------------------- settings --

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  shortcut: { mods: ['ctrl', 'alt'], keycode: UiohookKey.D, keyName: 'D', isModifier: false },
  mode: 'toggle',            // 'toggle' | 'hold'
  // 'paste'     copy, then paste
  // 'clipboard' copy only
  // 'type'      enter the text as keystrokes; the clipboard is never touched
  output: 'paste',
  // Paste mode only: put back whatever was on the clipboard before the
  // transcript displaced it.
  restoreClipboard: false,
  sounds: true,
  tidy: true,                // strip fillers and stutters from the transcript
  // Long recordings normally go through voice-activity chunking (Parakeet is
  // built for ~30s windows). But chunking runs the VAD model plus one call per
  // segment, so it is *slower* than a single pass — measurably so up to a
  // minute or two. Turn this on to always transcribe in one pass and skip the
  // chunking, trading a small quality risk on very long clips for speed.
  skipChunking: false,
  keywords: [],              // [{word, type: 'url'|'command', target}]
  theme: 'default',          // overlay colour scheme: 'default' | 'synthwave'
  duck: false,               // quieten other apps while recording
  duckLevel: 0.25,           // ...to this fraction of their own volume
  // Hold the microphone open between recordings. Opening it is a few hundred
  // milliseconds, and it all lands after the overlay says "Listening…", so this
  // is the difference between the first word being captured and being lost.
  // The cost is that the OS shows the mic as in use whenever the app is running.
  keepMicWarm: true,
  launchAtStartup: false,
  model: 'nemo-parakeet-tdt-0.6b-v2',
  quantization: 'int8',      // '' for full precision (bigger download, slower CPU)
};

// Set by the login item on every platform, so a startup launch goes straight
// to the tray instead of popping the settings window open.
const STARTED_HIDDEN = process.argv.includes('--hidden');

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...raw };
    if (!settings.shortcut || typeof settings.shortcut.keycode !== 'number') {
      settings.shortcut = { ...DEFAULT_SETTINGS.shortcut };
    }
  } catch { /* first run */ }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH()), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2));
  } catch (err) { console.error('settings save failed:', err); }
}

// ------------------------------------------------------------- auto-start --

// Each platform stores this somewhere different — a registry value, a login
// item, an XDG .desktop file — so the adapter owns both halves. Reading it back
// from the OS rather than from our settings file is deliberate: the user may
// have turned the entry off in Task Manager's Startup tab or System Settings,
// neither of which tells us.

function applyLaunchAtStartup(enabled) {
  try {
    platform.autostart.apply(enabled);
  } catch (err) { console.error('login item update failed:', err); }
}

function launchAtStartupEnabled() {
  try {
    return platform.autostart.enabled();
  } catch {
    return settings.launchAtStartup;
  }
}

// ------------------------------------------------------------- key naming --

// Invert uiohook's name -> keycode table so captured keys can be displayed.
const KEYCODE_NAMES = new Map();
for (const [name, code] of Object.entries(UiohookKey)) {
  if (!KEYCODE_NAMES.has(code)) KEYCODE_NAMES.set(code, name);
}

// keycode -> modifier group, covering both sides of each modifier.
const MOD_GROUPS = new Map([
  [UiohookKey.Ctrl, 'ctrl'], [UiohookKey.CtrlRight, 'ctrl'],
  [UiohookKey.Alt, 'alt'], [UiohookKey.AltRight, 'alt'],
  [UiohookKey.Shift, 'shift'], [UiohookKey.ShiftRight, 'shift'],
  [UiohookKey.Meta, 'meta'], [UiohookKey.MetaRight, 'meta'],
]);

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'];

// Same physical keys, three sets of names — a shortcut shown as "Alt + Win" on
// a Mac would name two keys that keyboard does not have.
const MOD_PRETTY = {
  win32: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' },
  darwin: { ctrl: 'Control', alt: 'Option', shift: 'Shift', meta: 'Cmd' },
  linux: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Super' },
}[platform.name];

function prettyKeyName(keycode) {
  const name = KEYCODE_NAMES.get(keycode) || `key ${keycode}`;
  const sides = {
    Ctrl: `Left ${MOD_PRETTY.ctrl}`, CtrlRight: `Right ${MOD_PRETTY.ctrl}`,
    Alt: `Left ${MOD_PRETTY.alt}`, AltRight: `Right ${MOD_PRETTY.alt}`,
    Shift: 'Left Shift', ShiftRight: 'Right Shift',
    Meta: `Left ${MOD_PRETTY.meta}`, MetaRight: `Right ${MOD_PRETTY.meta}`,
  };
  return sides[name] || name.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
}

function prettyShortcut(sc) {
  if (!sc) return '(none)';
  const parts = sc.mods.map((m) => MOD_PRETTY[m]);
  parts.push(sc.isModifier ? prettyKeyName(sc.keycode) : (sc.keyName || prettyKeyName(sc.keycode)));
  return parts.join(' + ');
}

// Keys safe to bind without a modifier: nothing anyone types into a document.
const SAFE_ALONE = new Set([
  ...Array.from({ length: 24 }, (_, i) => UiohookKey[`F${i + 1}`]).filter(Boolean),
  UiohookKey.Insert, UiohookKey.PrintScreen, UiohookKey.ScrollLock, UiohookKey.Pause,
]);

// ------------------------------------------------------------------ trace --

// Launch with SP2_DEBUG=1 to append a line per key event and state change to
// %TEMP%\screen-prompt-2-debug.log. A global-hook bug leaves nothing behind
// once it has happened — this is the only way to see which link in the chain
// gave way. Off by default, and a single boolean test when off.
const DEBUG = process.env.SP2_DEBUG === '1';
const DEBUG_LOG = path.join(os.tmpdir(), 'screen-prompt-2-debug.log');

function trace(...parts) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch { /* tracing must never be the thing that breaks it */ }
}

// -------------------------------------------------------- shortcut matcher --

// Port of the old project's HotkeyManager: match raw keycodes ourselves so a
// lone modifier (right Ctrl is popular for push-to-talk) is a usable shortcut,
// and Ctrl+C never trips a binding on Ctrl alone.
class ShortcutMatcher {
  constructor(onPress, onRelease, onAbort) {
    this.onPress = onPress;
    this.onRelease = onRelease;
    this.onAbort = onAbort;
    this.heldGroups = new Set();   // modifier groups currently down
    this.heldRaw = new Set();      // exact keycodes down
    this.usedMods = new Set();     // modifiers that joined a combination
    this.fired = new Set();        // main keys already fired (key-repeat guard)
    this.enabled = true;
    // True between a lone-modifier toggle firing on its press and that key
    // coming back up: the window in which the press might still turn out to
    // have been the start of a combination.
    this.speculative = false;
  }

  get sc() { return settings.shortcut; }

  anyKeysHeld() { return this.heldRaw.size > 0 || this.fired.size > 0; }

  keydown(keycode) {
    const group = MOD_GROUPS.get(keycode);
    if (group !== undefined) {
      // Captured before the add: a repeated key-down for a key already held
      // would otherwise toggle the recording off and straight back on. This
      // mattered much less when toggle fired on the release, which can only
      // happen once per press.
      const alreadyDown = this.heldRaw.has(keycode);
      this.heldGroups.add(group);
      this.heldRaw.add(keycode);
      // A lone-modifier shortcut fires on the press in both modes. Waiting for
      // the release would be the safe reading — the key is also a modifier, so
      // until it comes up this could still be the Ctrl of Ctrl+C — but that
      // wait is however long you happen to hold the key, and it is the delay
      // you feel before the pill appears. Firing now and undoing it below if a
      // combination materialises puts the cost on the rare case instead of
      // every single dictation.
      if (!alreadyDown && this.enabled && this.sc.isModifier
          && keycode === this.sc.keycode && this.othersHeld(group).size === 0) {
        if (settings.mode === 'toggle') this.speculative = true;
        this.onPress();
      }
      return;
    }

    // A real key: every modifier now down is part of a combination and must
    // not fire as a lone shortcut when released.
    for (const raw of this.heldRaw) this.usedMods.add(raw);

    // ...and if the shortcut modifier is one of them, the recording started on
    // its press was never wanted. Undo it before this keystroke is even done.
    if (this.speculative && this.heldRaw.has(this.sc.keycode)) {
      this.speculative = false;
      trace('matcher.abort', 'combination on the shortcut modifier');
      this.onAbort();
    }

    if (!this.enabled || this.sc.isModifier) return;
    if (this.fired.has(keycode)) return; // key repeat
    if (keycode === this.sc.keycode && this.groupsMatch()) {
      this.fired.add(keycode);
      this.onPress();
    }
  }

  keyup(keycode) {
    const group = MOD_GROUPS.get(keycode);
    if (group === undefined) {
      if (this.fired.delete(keycode)) this.onRelease();
      return;
    }

    this.heldGroups.delete(group);
    // Both sides of a group can be down; only drop the group when neither is.
    this.heldRaw.delete(keycode);
    for (const raw of this.heldRaw) {
      if (MOD_GROUPS.get(raw) === group) { this.heldGroups.add(group); break; }
    }

    if (!this.enabled || !this.sc.isModifier || keycode !== this.sc.keycode) {
      this.usedMods.delete(keycode);
      return;
    }
    trace('matcher.keyup', keycode,
      'mode=' + settings.mode,
      'enabled=' + this.enabled,
      'used=' + this.usedMods.has(keycode),
      'heldRaw=[' + [...this.heldRaw] + ']',
      'others=[' + [...this.othersHeld(group)] + ']');

    if (settings.mode === 'hold') {
      this.usedMods.delete(keycode);
      this.onRelease();
      return;
    }
    // Toggle already fired on the press, and any combination that press turned
    // out to belong to has already been undone. The release only clears state.
    this.usedMods.delete(keycode);
    this.speculative = false;
  }

  groupsMatch() {
    const want = new Set(this.sc.mods);
    if (want.size !== this.heldGroups.size) return false;
    for (const g of want) if (!this.heldGroups.has(g)) return false;
    return true;
  }

  othersHeld(ownGroup) {
    const others = new Set(this.heldGroups);
    others.delete(ownGroup);
    return others;
  }
}

// -------------------------------------------------------- shortcut capture --

// Captures one combination via the same uiohook stream that matching uses, so
// what you capture is exactly what will fire. Modifier held + key = combo;
// modifier tapped alone = lone-modifier shortcut; Esc cancels.
class ShortcutCapture {
  constructor(onEvent) {
    this.onEvent = onEvent;   // ({type, ...})
    this.active = false;
    this.heldGroups = new Set();
    this.pendingLone = null;
    this.anyKeyPressed = false;
  }

  start() {
    this.active = true;
    this.heldGroups.clear();
    this.pendingLone = null;
    this.anyKeyPressed = false;
    this.onEvent({ type: 'held', display: 'Press a shortcut…' });
  }

  cancel() { this.active = false; }

  heldDisplay() {
    const parts = MOD_ORDER.filter((m) => this.heldGroups.has(m)).map((m) => MOD_PRETTY[m]);
    return parts.length ? parts.join(' + ') + ' + …' : 'Press a shortcut…';
  }

  keydown(keycode) {
    if (!this.active) return;
    if (keycode === UiohookKey.Escape) {
      this.active = false;
      this.onEvent({ type: 'cancelled' });
      return;
    }
    const group = MOD_GROUPS.get(keycode);
    if (group !== undefined) {
      this.heldGroups.add(group);
      this.pendingLone = keycode;
      this.onEvent({ type: 'held', display: this.heldDisplay() });
      return;
    }
    this.anyKeyPressed = true;
    const mods = MOD_ORDER.filter((m) => this.heldGroups.has(m));
    if (mods.length === 0 && !SAFE_ALONE.has(keycode)) {
      this.onEvent({
        type: 'error',
        message: `${prettyKeyName(keycode)} on its own would fire while you type. Hold a modifier with it, or use a function key.`,
      });
      return;
    }
    this.commit({ mods, keycode, keyName: prettyKeyName(keycode), isModifier: false });
  }

  keyup(keycode) {
    if (!this.active) return;
    const group = MOD_GROUPS.get(keycode);
    if (group === undefined) return;
    // Released without any other key: they meant this modifier by itself.
    if (keycode === this.pendingLone && !this.anyKeyPressed) {
      this.commit({ mods: [], keycode, keyName: prettyKeyName(keycode), isModifier: true });
      return;
    }
    this.heldGroups.delete(group);
    this.onEvent({ type: 'held', display: this.heldDisplay() });
  }

  commit(sc) {
    this.active = false;
    settings.shortcut = sc;
    saveSettings();
    this.onEvent({ type: 'done', pretty: prettyShortcut(sc) });
  }
}

// ------------------------------------------------------------ ASR sidecar --

class Sidecar {
  constructor() {
    this.proc = null;
    this.state = 'stopped';   // stopped | loading | ready | error
    this.detail = '';
    this.pending = new Map(); // id -> {resolve, reject}
    this.nextId = 1;
    this.restarts = 0;
    this.buf = '';
    this.progress = null;     // {done, total, speed, finished} while downloading
  }

  pythonPath() {
    return platform.pythonPath();
  }

  start() {
    if (this.proc) return;
    const py = this.pythonPath();
    if (!fs.existsSync(py)) {
      this.state = 'error';
      this.detail = `Python environment missing — run \`${platform.setupCommand}\` first.`;
      broadcastState();
      return;
    }
    this.state = 'loading';
    this.detail = 'Loading Parakeet v2…';
    this.progress = null;
    broadcastState();

    const args = [path.join(__dirname, 'asr', 'server.py'),
      '--model', settings.model, '--quantization', settings.quantization];
    this.proc = spawn(py, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) console.error('[asr]', line.slice(0, 400));
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      for (const { reject } of this.pending.values()) reject(new Error('transcriber exited'));
      this.pending.clear();
      if (this.state !== 'error') { this.state = 'error'; this.detail = `Transcriber exited (code ${code}).`; }
      broadcastState();
      if (this.restarts < 2) { this.restarts += 1; setTimeout(() => this.start(), 1500); }
    });
  }

  onData(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event === 'status') {
        this.state = msg.state;
        this.detail = msg.detail || '';
        if (msg.state === 'ready') { this.detail = ''; this.restarts = 0; this.progress = null; }
        broadcastState();
      } else if (msg.event === 'progress') {
        this.progress = { done: msg.done, total: msg.total, speed: msg.speed, finished: msg.finished };
        broadcastState();
      } else if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg.text || '');
      }
    }
  }

  transcribe(wavPath, chunk = true) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.state !== 'ready') {
        reject(new Error(this.state === 'loading'
          ? 'The model is still loading — try again in a moment.'
          : (this.detail || 'Transcriber is not running.')));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd: 'transcribe', wav: wavPath, chunk }) + '\n');
    });
  }

  stop() {
    if (this.proc) { this.restarts = 99; try { this.proc.kill(); } catch { } this.proc = null; }
  }
}

// ---------------------------------------------------------- volume ducking --

// Turns other apps down while you talk, so the mic hears you rather than your
// speakers. The work happens in a sidecar — audio/ducker.ps1 on Windows,
// audio/ducker.py elsewhere — and both speak the same JSON-lines protocol, so
// this side only manages its lifetime and the two commands it understands.
class Ducker {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.ducked = false;
    this.buf = '';
  }

  start() {
    if (this.proc || !platform.ducking.supported) return;
    this.ready = false;
    const { file, args } = platform.ducking.command(platform.pythonPath());
    this.proc = spawn(file, args,
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString();
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === 'status') {
          this.ready = msg.state === 'ready';
          if (msg.state === 'error') console.error('[duck]', msg.detail);
          // The helper puts back anything a previous run was killed before
          // restoring. Worth saying out loud: it means something did go wrong
          // last time, even though it has just been repaired.
          if (msg.recovered > 0) {
            console.log('[duck]', `restored ${msg.recovered} volume(s) that a `
              + 'previous run was killed before putting back');
          }
        } else if (msg.event === 'error') {
          console.error('[duck]', msg.detail);
        }
      }
    });
    this.proc.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) console.error('[duck]', line.slice(0, 400));
    });
    // The helper is the venv interpreter off Windows, so it can genuinely be
    // missing. Without a listener that spawn failure is an unhandled 'error'
    // event, which takes the whole app down over an optional feature.
    this.proc.on('error', (err) => {
      console.error('[duck]', err.message);
      this.proc = null; this.ready = false; this.ducked = false;
    });
    this.proc.on('exit', () => { this.proc = null; this.ready = false; this.ducked = false; });
  }

  send(msg) {
    if (this.proc) { try { this.proc.stdin.write(JSON.stringify(msg) + '\n'); } catch { } }
  }

  duck() {
    if (!settings.duck || !this.ready || this.ducked) return;
    this.ducked = true;
    this.send({
      cmd: 'duck',
      level: Math.min(1, Math.max(0, settings.duckLevel)),
      // Chromium plays our tones from an audio-service child process, so the
      // exempt set has to be the whole tree — they share this executable name.
      skipName: path.basename(process.execPath, '.exe'),
    });
  }

  restore() {
    if (!this.ducked) return;
    this.ducked = false;
    this.send({ cmd: 'restore' });
  }

  // Closing stdin is the clean stop: the helper's read loop ends and its
  // `finally` restores, so we never need to race a kill against the restore.
  stop() {
    this.restore();
    if (this.proc) { try { this.proc.stdin.end(); } catch { } }
  }
}

// ---------------------------------------------------------------- windows --

let settingsWin = null;
let overlayWin = null;
let tray = null;
let quitting = false;

function createSettingsWindow() {
  // Capped to the work area so the last card is still reachable on a short
  // screen — the body scrolls if the window has to be smaller than the content.
  const height = Math.min(1140, screen.getPrimaryDisplay().workArea.height - 60);
  settingsWin = new BrowserWindow({
    width: 480, height, resizable: false, maximizable: false,
    title: 'Screen Prompt 2', icon: trayIcon(),
    backgroundColor: '#14161b', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => { if (!STARTED_HIDDEN) settingsWin.show(); });
  settingsWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); settingsWin.hide(); }
  });
}

function createOverlayWindow() {
  overlayWin = new BrowserWindow({
    width: 360, height: 120, show: false, frame: false, transparent: true,
    resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  // macOS needs one more call to stay visible over a fullscreen app.
  platform.tuneOverlay?.(overlayWin);
  // Open the microphone as soon as the renderer exists, so the very first
  // recording after launch is as fast as every one after it.
  overlayWin.webContents.once('did-finish-load', () => {
    if (settings.keepMicWarm) overlayCmd({ cmd: 'warm' });
  });
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
}

// The pill belongs on the screen you are looking at, and the cursor is the
// best available proxy for that — the overlay never takes focus, so there is
// no focused window to follow.
function cursorDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function positionOverlay(display = cursorDisplay()) {
  const { workArea } = display;
  const [w, h] = overlayWin.getSize();
  // setBounds rather than setPosition: it pins the DIP size too, so moving to
  // a monitor with a different scale factor can't leave the pill resized.
  overlayWin.setBounds({
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + workArea.height - h - 48),
    width: w, height: h,
  });
}

// Follow the cursor across monitors while recording. Polling because Electron
// has no cursor-moved event and the overlay is click-through by design, so it
// sees no mouse events of its own. Only a display change moves the window.
let followTimer = null;
let followDisplayId = null;

function startFollowingCursor() {
  stopFollowingCursor();
  followDisplayId = cursorDisplay().id;
  followTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const display = cursorDisplay();
    if (display.id === followDisplayId) return;
    followDisplayId = display.id;
    positionOverlay(display);
  }, 200);
}

function stopFollowingCursor() {
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
}

// Every command carries the current theme, so the overlay is repainted in the
// right colours by the time it is shown — no separate load-time handshake.
function overlayCmd(payload) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:cmd',
      { theme: settings.theme, warm: settings.keepMicWarm, ...payload });
  }
}

// A small procedural microphone dot for the tray; replaced by assets/icon.png
// when present.
function trayIcon() {
  const p = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  const size = 16, buf = Buffer.alloc(size * size * 4);
  const cx = 7.5, cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = d < 6 ? 255 : d < 7 ? Math.round(255 * (7 - d)) : 0;
      const i = (y * size + x) * 4;
      buf[i] = 216; buf[i + 1] = 130; buf[i + 2] = 90; buf[i + 3] = a; // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  const icon = trayIcon();
  // A template image is drawn as a mask, so the menu bar inverts it with the
  // rest of its contents — a fixed-colour icon is the one that looks broken in
  // dark mode. macOS only; elsewhere the flag means nothing.
  if (platform.name === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Screen Prompt 2');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Settings', click: () => { settingsWin.show(); settingsWin.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { settingsWin.show(); settingsWin.focus(); });
}

// ---------------------------------------------------------------- tidying --

// Parakeet transcribes faithfully, which means every "um", every stutter and
// every false start lands in the text. This is the edit you would make by hand
// before pasting it anywhere: drop the fillers, collapse the repeats, and
// leave the punctuation looking like nothing happened.

const FILLERS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'uhm', 'uhhm', 'erm', 'mmm',
]);

// Words that genuinely double in English, where a repeat is meant: "he had had
// enough", "I know that that is true", "very very good", "no no no".
const REPEATABLE = new Set(['had', 'that', 'very', 'really', 'no', 'yes']);

const LEAD_PUNCT = /^[^\p{L}\p{N}]+/u;
const TAIL_PUNCT = /[^\p{L}\p{N}]+$/u;

// Comparison form only — never what gets written back out. Curly apostrophes
// are folded to straight ones so "I I’m" collapses the same way "I I'm" does.
const wordOf = (token) => token
  .replace(LEAD_PUNCT, '').replace(TAIL_PUNCT, '')
  .replace(/’/g, "'")
  .toLowerCase();
const tailOf = (token) => (token.match(TAIL_PUNCT) || [''])[0];

// "the" -> "The" when the token it replaces started a sentence.
function matchCapital(previous, token) {
  const a = previous.replace(LEAD_PUNCT, '');
  const b = token.replace(LEAD_PUNCT, '');
  if (!a || !b) return token;
  const wasCapital = a[0] === a[0].toUpperCase() && a[0] !== a[0].toLowerCase();
  return wasCapital && b[0] !== b[0].toUpperCase() ? capitalize(token) : token;
}

function capitalize(token) {
  const lead = (token.match(LEAD_PUNCT) || [''])[0];
  const rest = token.slice(lead.length);
  return rest ? lead + rest[0].toUpperCase() + rest.slice(1) : token;
}

// Tokens carry an `afterDrop` flag through the passes, so the final capital
// fix knows which words landed at the front of a sentence because something
// ahead of them was removed. Tracking that by index instead would mean
// re-basing the indices every time a later pass removes a token.

// Pass 1 — "um", "uh" and friends.
function dropFillers(tokens) {
  const out = [];
  let dropped = false;
  for (const token of tokens) {
    const word = wordOf(token);
    if (word && FILLERS.has(word)) {
      // A filler that ended the sentence takes the full stop with it, so hand
      // the punctuation back: "So um. Yeah" -> "So. Yeah", not "So Yeah".
      const tail = tailOf(token);
      const last = out.length - 1;
      if (tail && last >= 0 && !tailOf(out[last].text)) out[last].text += tail;
      dropped = true;
      continue;
    }
    out.push({ text: token, afterDrop: dropped });
    dropped = false;
  }
  return out;
}

// The abandoned-attempt pattern: "I d I don't know", "so I g I guess". The
// give-away is the same word twice with a cut-off fragment between them, where
// the fragment begins the word that follows the repeat. Requiring that
// bracketing repeat is what makes this safe — a bare "drop a word that
// prefixes the next one" rule would eat the "the" in "the theme" and the "so"
// in "so something". Returns the index to resume at, or -1.
function falseStartAt(items, i) {
  const word = wordOf(items[i].text);
  if (!word) return -1;
  for (const j of [i + 2, i + 3]) {
    if (j + 1 >= items.length) break;          // nothing to restart into
    if (wordOf(items[j].text) !== word) continue;
    const repair = wordOf(items[j + 1].text);
    if (!repair) continue;
    let fragments = true;
    for (let k = i + 1; k < j && fragments; k++) {
      const frag = wordOf(items[k].text);
      // Strictly shorter, so a whole repeated word is not mistaken for a
      // fragment of itself: "I am I am here" is a phrase repeat, not this.
      fragments = !!frag && frag.length < repair.length && repair.startsWith(frag);
    }
    if (fragments) return j;
  }
  return -1;
}

// Pass 2 — abandoned restarts, then plain repeats.
function dropRestarts(items) {
  const out = [];
  let dropped = false;
  for (let i = 0; i < items.length; i++) {
    const token = items[i].text;
    const word = wordOf(token);
    const afterDrop = items[i].afterDrop || dropped;
    dropped = false;

    if (word) {
      const resume = falseStartAt(items, i);
      if (resume > i) {
        dropped = true;
        i = resume - 1;   // the loop's ++ lands on the repeat itself
        continue;
      }
      // "the the" collapsed, and the contraction restart "I I'm", "it it's".
      const previous = out.length ? wordOf(out[out.length - 1].text) : '';
      if (previous && !REPEATABLE.has(word)
          && (previous === word || word.startsWith(previous + "'"))) {
        const last = out.length - 1;
        // Keep the later token — it carries the punctuation leading into what
        // follows — but not at the cost of a lost capital.
        out[last].text = matchCapital(out[last].text, token);
        continue;
      }
    }
    out.push({ text: token, afterDrop });
  }
  return out;
}

function tidyTranscript(text) {
  const items = dropRestarts(dropFillers(text.split(/\s+/).filter(Boolean)));

  // A removal can leave a sentence starting in lower case. An ellipsis is a
  // continuation rather than a sentence end, so it does not count — hence the
  // lookbehind, and no "…" in the class.
  for (let i = 0; i < items.length; i++) {
    if (!items[i].afterDrop) continue;
    if (i === 0 || /(?<!\.)[.!?]["')\]]?$/.test(items[i - 1].text)) {
      items[i].text = capitalize(items[i].text);
    }
  }

  return items.map((item) => item.text).join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')   // no space before punctuation
    .replace(/([,;:])\1+/g, '$1')      // ", ," collapsed by a dropped token
    .replace(/\s+/g, ' ')
    .trim();
}

// --------------------------------------------------------------- keywords --

// Say "Google, what is the capital of Indiana" and the rest of the sentence
// becomes the query. A keyword only counts at the very start of what you said,
// so "Google is a big company" typed into a document is left alone unless
// "Google" is the first thing out of your mouth.

// Matches the longest keyword that starts the transcript, or null.
function matchKeyword(text) {
  const lower = text.toLowerCase();
  let best = null;
  for (const entry of settings.keywords || []) {
    const word = String(entry.word || '').trim().toLowerCase();
    if (!word || !entry.target) continue;
    if (!lower.startsWith(word)) continue;
    // "Googleplex" must not fire the "Google" keyword.
    const rest = text.slice(word.length);
    if (rest && /[\p{L}\p{N}]/u.test(rest[0])) continue;
    if (best && best.word.length >= word.length) continue;
    best = {
      word,
      type: entry.type === 'command' ? 'command' : 'url',
      target: String(entry.target),
      // Drop whatever punctuation the model put after the keyword.
      query: rest.replace(/^[^\p{L}\p{N}]+/u, '').trim(),
    };
  }
  return best;
}

// Quote-aware split, so a command target can name a path with spaces.
function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const LAUNCH_GRACE_MS = 200;    // long enough to catch a bad path
const LAUNCH_WATCH_MS = 5000;   // ...and a launcher that fails just after it

function exitMessage(code, stderr) {
  const first = stderr.trim().split('\n')[0].trim();
  return first ? first.slice(0, 140) : `Command exited with code ${code}.`;
}

// Spawned without a shell, so nothing in the spoken query can be read as a
// shell operator — the words become one argument, whatever is in them. Point
// the target at `cmd /c ...` yourself if you actually want shell syntax.
//
// Deliberately not `detached`. On Windows that flag is DETACHED_PROCESS, which
// denies the child a console — and a console program handed no console exits 0
// having run none of its code. A powershell.exe target therefore reported a
// clean success and launched nothing at all. `windowsHide` is the flag we
// actually wanted: a console exists, it just has no window to flash. The child
// still outlives us, because Windows does not kill it when we go.
//
// A launcher usually outlives the grace period, so its exit code arrives long
// after we have told you it worked. `onLateFailure` is how that gets corrected
// on screen instead of being swallowed — the alternative is a keyword that
// cheerfully reports success when nothing happened.
function launch(argv, onLateFailure) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1),
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const started = Date.now();
    let settled = false;
    let stderr = '';

    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        if (code === 0) resolve();
        else reject(new Error(exitMessage(code, stderr)));
        return;
      }
      // Past the grace period. Only complain while the failure is still
      // plausibly about this launch — closing the app an hour later is not it.
      if (code !== 0 && Date.now() - started < LAUNCH_WATCH_MS) {
        onLateFailure(exitMessage(code, stderr));
      }
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    }, LAUNCH_GRACE_MS);
  });
}

// Returns the line to show in the overlay.
async function runKeyword(keyword) {
  const { word, query } = keyword;
  const pretty = word.charAt(0).toUpperCase() + word.slice(1);
  if (keyword.type === 'command') {
    const argv = splitArgs(keyword.target).map((arg) => arg.replace(/%s/g, query));
    if (!argv.length) throw new Error(`Keyword "${word}" has no command to run.`);
    await launch(argv, (message) => {
      // Replaces the success pill still on screen. Skipped if you have already
      // started talking again — that overlay belongs to the new recording.
      if (appState !== 'idle') return;
      finishOverlay({ cmd: 'error', sounds: settings.sounds, message }, 2800);
    });
    return `▶ ${pretty}${query ? ` — ${query}` : ''}`;
  }
  const encoded = encodeURIComponent(query);
  // No %s means the query goes on the end, the way a bare search prefix works.
  const url = keyword.target.includes('%s')
    ? keyword.target.replace(/%s/g, encoded)
    : keyword.target + encoded;
  await shell.openExternal(url);
  return `↗ ${pretty}${query ? ` — ${query}` : ''}`;
}

// ------------------------------------------------------------ state machine --

const sidecar = new Sidecar();
const ducker = new Ducker();
let appState = 'idle'; // idle | recording | processing
let lastText = '';

function broadcastState() {
  const payload = {
    appState,
    modelState: sidecar.state,
    modelDetail: sidecar.detail,
    modelProgress: sidecar.progress,
    pretty: prettyShortcut(settings.shortcut),
  };
  for (const win of [settingsWin, overlayWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', payload);
  }
}

function startRecording() {
  trace('startRecording', 'state=' + appState);
  if (appState !== 'idle') return;
  appState = 'recording';
  positionOverlay();
  overlayWin.showInactive();
  startFollowingCursor();
  ducker.duck();
  overlayCmd({ cmd: 'start', sounds: settings.sounds });
  broadcastState();
}

function stopRecording() {
  trace('stopRecording', 'state=' + appState);
  if (appState !== 'recording') return;
  appState = 'processing';
  // The result pill stays where you finished talking rather than chasing the
  // cursor around while the model runs, and the room gets its volume back
  // without waiting on the transcription.
  stopFollowingCursor();
  ducker.restore();
  overlayCmd({ cmd: 'stop', sounds: settings.sounds });
  broadcastState();
}

function onShortcutPress() {
  if (settings.mode === 'hold') { startRecording(); return; }
  if (appState === 'idle') startRecording();
  else if (appState === 'recording') stopRecording();
}

function onShortcutRelease() {
  if (settings.mode === 'hold') stopRecording();
}

// Bumped by every cancellation. A transcription already in flight compares the
// value it started with against the current one and drops its result if they
// differ — the model cannot be interrupted, so the only way to honour Escape
// during "Transcribing…" is to ignore the answer when it arrives.
let cancelGeneration = 0;

// Escape means stop, whatever is happening: throw the recording away, or
// abandon a transcription that is already running. Returns whether there was
// anything to stop, so an Escape pressed while idle stays an ordinary keystroke.
function cancelEverything() {
  if (appState === 'idle') return false;
  trace('cancelEverything', 'state=' + appState);
  cancelGeneration += 1;
  stopFollowingCursor();
  ducker.restore();
  appState = 'idle';
  // The overlay stops capturing and discards the audio on this command, so no
  // 'stop' is sent and handleAudio is never reached for a cancelled recording.
  finishOverlay({ cmd: 'cancel', sounds: settings.sounds }, 1200);
  broadcastState();
  return true;
}

// The shortcut modifier turned out to be part of a combination, so the
// recording started on its press was never wanted. Dropped without a sound and
// without a message: this fires during ordinary typing, and a cancel tone every
// time you pressed Right Ctrl + C would be far worse than the wait it replaced.
//
// Only a recording is undone. If the press was the second tap of a toggle the
// state is already 'processing' — the audio is on its way to the model and
// stopping that would lose what you actually said.
function onShortcutAbort() {
  trace('onShortcutAbort', 'state=' + appState);
  if (appState !== 'recording') return;
  stopFollowingCursor();
  ducker.restore();
  appState = 'idle';
  clearTimeout(hideTimer);
  overlayCmd({ cmd: 'abort' });
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
  broadcastState();
}

let hideTimer = null;
function finishOverlay(payload, delay) {
  overlayCmd(payload);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (overlayWin && appState === 'idle') overlayWin.hide(); }, delay);
}

// Also unwinds the follow and the ducking: a failed startCapture (mic
// unavailable) lands here without ever passing through stopRecording.
function backToIdle() {
  stopFollowingCursor();
  ducker.restore();
  appState = 'idle';
  broadcastState();
}

async function handleAudio(buffer, duration, cancelled, error) {
  trace('handleAudio', 'state=' + appState, 'duration=' + duration,
    'cancelled=' + cancelled, 'error=' + (error || 'none'));
  if (error) {
    backToIdle();
    finishOverlay({ cmd: 'error', sounds: settings.sounds, message: error }, 2600);
    return;
  }
  if (cancelled || duration < 0.35) {
    backToIdle();
    finishOverlay({ cmd: 'cancel', sounds: settings.sounds }, 600);
    return;
  }
  const wavPath = path.join(os.tmpdir(), `screen-prompt-2-${Date.now()}.wav`);
  // Captured before the await, compared after it. Escape during "Transcribing…"
  // cannot stop the model, so this is what stops its answer being used.
  const generation = cancelGeneration;
  try {
    fs.writeFileSync(wavPath, Buffer.from(buffer));
    const raw = (await sidecar.transcribe(wavPath, !settings.skipChunking)).trim();
    if (generation !== cancelGeneration) {
      trace('handleAudio abandoned', 'cancelled while transcribing');
      return;
    }
    const text = settings.tidy ? tidyTranscript(raw) : raw;
    // A recording that was nothing but "um" tidies down to nothing at all.
    if (!text) throw new Error('No speech recognized.');
    lastText = text;
    // Recorded before the keyword runs, so the settings window still shows
    // what was heard when the words went somewhere other than the clipboard.
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('transcription', { text });
    }

    // A keyword takes the place of pasting: the words were an instruction, not
    // something to type.
    const keyword = matchKeyword(text);
    if (keyword) {
      const label = await runKeyword(keyword);
      backToIdle();
      finishOverlay({ cmd: 'done', sounds: settings.sounds, text, label }, 1800);
      return;
    }

    const verb = await deliver(text);
    backToIdle();
    finishOverlay({ cmd: 'done', sounds: settings.sounds, text, verb }, 1600);
  } catch (err) {
    // A transcription that failed *and* was cancelled has nothing to report:
    // the "Cancelled" pill is already up and an error over it would be noise.
    if (generation !== cancelGeneration) return;
    backToIdle();
    finishOverlay({ cmd: 'error', sounds: settings.sounds, message: String(err.message || err) }, 2600);
  } finally {
    fs.unlink(wavPath, () => { });
  }
}

// ---------------------------------------------------------------- delivery --

// How long to leave the transcript on the clipboard before putting the previous
// contents back. Ctrl+V returns the instant it is sent; the application reads
// the clipboard some milliseconds later, on its own thread, and there is no
// event to wait for. Too short and the paste arrives empty or stale, so this is
// generous — it only costs anything when clipboard restore is switched on.
const CLIPBOARD_SETTLE_MS = 400;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Text, HTML, RTF and images are preserved. Copied *files* are not: Electron
// exposes no way to write file references back, so a clipboard holding files
// cannot be restored — it is left holding the transcript instead.
function readClipboard() {
  const image = clipboard.readImage();
  return {
    hadContent: clipboard.availableFormats().length > 0,
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: image.isEmpty() ? null : image,
  };
}

function writeClipboard(saved) {
  if (!saved.hadContent) { clipboard.clear(); return; }
  const data = {};
  if (saved.text) data.text = saved.text;
  if (saved.html) data.html = saved.html;
  if (saved.rtf) data.rtf = saved.rtf;
  if (saved.image) data.image = saved.image;
  // Nothing writable came back — the clipboard held something this cannot
  // reproduce, and leaving the transcript there is less surprising than
  // clearing it outright.
  if (Object.keys(data).length) clipboard.write(data);
}

// Gets the transcript where it is going, and returns the past-tense verb the
// overlay reports.
async function deliver(text) {
  if (settings.output === 'type') {
    try {
      await platform.typeText(text);
      return 'Typed';
    } catch (err) {
      // Falls back rather than losing the words. Type mode exists to keep the
      // clipboard clean, but a dirty clipboard beats a transcript that went
      // nowhere.
      console.error('[type]', err.message);
      clipboard.writeText(text);
      return 'Copied';
    }
  }

  const previous = settings.output === 'paste' && settings.restoreClipboard
    ? readClipboard()
    : null;

  clipboard.writeText(text);
  if (settings.output !== 'paste') return 'Copied';

  await pasteIntoActiveApp();
  if (previous) {
    await delay(CLIPBOARD_SETTLE_MS);
    writeClipboard(previous);
  }
  return 'Pasted';
}

// ------------------------------------------------------------------- paste --

// Synthesises the paste chord into whatever owns the caret — the overlay never
// takes focus, so that is still the app you were typing in. How it is done is
// per-platform (see platform/), and on Linux it can be genuinely unavailable;
// the text is already on the clipboard by this point either way, so a failure
// here degrades to "paste it yourself" rather than losing the transcript.
function pasteIntoActiveApp() {
  return waitForKeysReleased(2000)
    .then(() => platform.paste())
    .catch((err) => { console.error('[paste]', err.message); });
}

// If the shortcut keys are still physically down (hold mode with a fast
// transcription), Ctrl+V would combine with them into a different chord.
function waitForKeysReleased(timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      if (!matcher.anyKeysHeld() || Date.now() - t0 > timeoutMs) resolve();
      else setTimeout(poll, 50);
    };
    poll();
  });
}

// --------------------------------------------------------------------- IPC --

const matcher = new ShortcutMatcher(onShortcutPress, onShortcutRelease, onShortcutAbort);
const capture = new ShortcutCapture((event) => {
  matcher.enabled = !capture.active;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('shortcut:capture:event', event);
  }
  if (event.type === 'done') broadcastState();
});

ipcMain.handle('settings:get', () => ({
  settings: {
    mode: settings.mode, output: settings.output, sounds: settings.sounds,
    launchAtStartup: launchAtStartupEnabled(), model: settings.model,
    theme: settings.theme, duck: settings.duck, duckLevel: settings.duckLevel,
    tidy: settings.tidy, keywords: settings.keywords,
    skipChunking: settings.skipChunking,
    keepMicWarm: settings.keepMicWarm,
    restoreClipboard: settings.restoreClipboard,
  },
  pretty: prettyShortcut(settings.shortcut),
  appState,
  modelState: sidecar.state,
  modelDetail: sidecar.detail,
  modelProgress: sidecar.progress,
  lastText,
  // Lets one settings page describe three operating systems honestly: the
  // labels, the example command and the ducking caveat all come from here
  // rather than being hardcoded to whichever OS this was written on.
  platform: {
    name: platform.name,
    prettyName: platform.prettyName,
    autostartLabel: platform.autostartLabel,
    commandExample: platform.commandExample,
    launchAppTarget: platform.launchAppTarget(),
    ducking: {
      supported: platform.ducking.supported,
      scope: platform.ducking.scope,
      note: platform.ducking.note,
    },
    canRequestPermission: Boolean(platform.requestPermission),
    ...platform.capabilities(),
  },
}));

// macOS shows the Accessibility prompt once and never again, so this is wired
// to a button rather than fired at startup where it would be missed.
ipcMain.handle('platform:request-permission', () => (
  platform.requestPermission ? platform.requestPermission() : true
));

ipcMain.handle('settings:set', (_e, partial) => {
  for (const key of ['mode', 'output', 'sounds', 'theme', 'duckLevel', 'tidy',
    'skipChunking', 'restoreClipboard']) {
    if (partial[key] !== undefined) settings[key] = partial[key];
  }
  if (partial.launchAtStartup !== undefined) {
    settings.launchAtStartup = partial.launchAtStartup;
    applyLaunchAtStartup(partial.launchAtStartup);
  }
  if (partial.keepMicWarm !== undefined) {
    settings.keepMicWarm = partial.keepMicWarm;
    // Opens the device now on enable; on disable the overlay sees the flag on
    // this same command and closes it.
    overlayCmd({ cmd: 'warm' });
  }
  if (Array.isArray(partial.keywords)) {
    // Half-filled rows are kept rather than dropped — you are probably still
    // typing one — and simply never match until both halves are there.
    settings.keywords = partial.keywords.slice(0, 64).map((entry) => ({
      word: String(entry.word || '').trim(),
      type: entry.type === 'command' ? 'command' : 'url',
      target: String(entry.target || '').trim(),
    }));
  }
  if (partial.duck !== undefined) {
    settings.duck = partial.duck;
    // Started eagerly on enable rather than at the first recording: the helper
    // spends a second or two compiling its interop types, and that would
    // otherwise land on the first press and silently skip the duck.
    if (settings.duck) ducker.start();
    else ducker.stop();
  }
  // Repaint a visible overlay straight away, so picking a scheme shows itself.
  if (partial.theme !== undefined) overlayCmd({ cmd: 'theme' });
  saveSettings();
  broadcastState();
});

// The clipboard lives in main, so the settings window asks rather than
// reaching for navigator.clipboard, which needs a secure context.
ipcMain.handle('clipboard:write', (_e, text) => {
  const value = String(text || '');
  if (value) clipboard.writeText(value);
});

ipcMain.handle('shortcut:capture:start', () => capture.start());
ipcMain.handle('shortcut:capture:cancel', () => {
  capture.cancel();
  matcher.enabled = true;
});

ipcMain.on('overlay:audio', (_e, { buffer, duration, cancelled, error }) => {
  handleAudio(buffer, duration, cancelled, error);
});

// -------------------------------------------------------------------- boot --

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (settingsWin) { settingsWin.show(); settingsWin.focus(); } });

  app.whenReady().then(() => {
    loadSettings();
    // Hide the dock icon on macOS, before any window exists to put one there.
    platform.onReady?.();
    // Keep the login item in step with the setting: the app directory moves, or
    // a packaged build replaces the dev one, and a stale entry would silently
    // launch nothing.
    if (settings.launchAtStartup) applyLaunchAtStartup(true);
    for (const warning of platform.capabilities().warnings) {
      console.warn('[platform]', warning);
    }
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media');
    });

    createSettingsWindow();
    createOverlayWindow();
    createTray();
    sidecar.start();
    if (settings.duck) ducker.start();

    uIOhook.on('keydown', (e) => {
      if (e.keycode === settings.shortcut.keycode) {
        trace('hook down', e.keycode, 'capturing=' + capture.active, 'state=' + appState);
      }
      if (capture.active) { capture.keydown(e.keycode); return; }
      // Escape cancels a recording or a transcription outright. Only consumed
      // when there was something to cancel, so it stays an ordinary Escape the
      // rest of the time — and it is observed rather than swallowed either way,
      // so the focused app still receives it.
      if (e.keycode === UiohookKey.Escape && cancelEverything()) return;
      matcher.keydown(e.keycode);
    });
    uIOhook.on('keyup', (e) => {
      if (e.keycode === settings.shortcut.keycode) {
        trace('hook up', e.keycode, 'capturing=' + capture.active, 'state=' + appState);
      }
      if (capture.active) capture.keyup(e.keycode);
      else matcher.keyup(e.keycode);
    });
    uIOhook.start();
  });

  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('before-quit', () => {
    quitting = true;
    try { uIOhook.stop(); } catch { }
    sidecar.stop();
    ducker.stop();
    // Closes the typing helper, if type mode ever started one.
    platform.shutdown?.();
  });
}
