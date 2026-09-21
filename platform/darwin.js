// macOS adapter.
//
// Two things differ from Windows in ways a user will notice, and both are
// platform limits rather than shortcuts taken here:
//
//   * Ducking is system-wide. macOS has no public per-application volume API —
//     CoreAudio exposes output device volume, not per-process mixer sessions —
//     so the whole output is turned down and put back. The app's own tones are
//     quietened along with everything else.
//   * The global shortcut and the synthetic paste both need Accessibility
//     permission. Nothing works until it is granted, and macOS only shows the
//     prompt once, so `capabilities()` reports the state on every launch.

const path = require('path');
const { execFile } = require('child_process');
const { app, systemPreferences } = require('electron');

const ROOT = path.join(__dirname, '..');

// System Events types the chord into whatever owns the caret. The overlay is
// non-activating, so that is still the app you were typing in.
const PASTE_SCRIPT =
  'tell application "System Events" to keystroke "v" using command down';

// AppleScript string literals cannot contain a raw newline, so a multi-line
// transcript becomes a concatenation with `return` between the pieces —
// `keystroke "a" & return & "b"` types the line break as an actual Return.
function appleScriptString(text) {
  const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return text.replace(/\r\n?/g, '\n').split('\n').map(quote).join(' & return & ');
}

// ------------------------------------------------------------ key combos --

// AppleScript has two ways to press a key and they take different arguments.
// `keystroke "c"` names a character, which is what you want for the keys that
// produce one: it resolves through the layout, so Cmd+Z stays Cmd+Z wherever
// the Z is. `key code 123` names a position, which is the only way to reach
// the keys that produce nothing. Everything below is one or the other.
const CHAR_KEYS = {
  semicolon: ';', equal: '=', comma: ',', minus: '-', period: '.', slash: '/',
  backquote: '`', bracketleft: '[', backslash: '\\', bracketright: ']', quote: "'",
};

const CODE_KEYS = {
  enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117,
  arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, capslock: 57,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
  f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
  numpad0: 82, numpad1: 83, numpad2: 84, numpad3: 85, numpad4: 86,
  numpad5: 87, numpad6: 88, numpad7: 89, numpad8: 91, numpad9: 92,
  numpadenter: 76, numpadadd: 69, numpadsubtract: 78, numpadmultiply: 67,
  numpaddivide: 75, numpaddecimal: 65,
  // A modifier recorded on its own. Tapping one does nothing by itself in most
  // applications, but refusing to send what was recorded would be worse.
  ctrl: 59, shift: 56, alt: 58, meta: 55,
};

const MOD_PHRASE = {
  ctrl: 'control down', alt: 'option down', shift: 'shift down', meta: 'command down',
};

// `using {…}` takes a list, and a one-element list is written without braces in
// some examples but accepts them everywhere, so one form covers every case.
function chordScript(mods, key) {
  const using = mods.length
    ? ` using {${mods.map((mod) => MOD_PHRASE[mod]).join(', ')}}`
    : '';
  const char = /^[a-z0-9]$/.test(key) ? key : CHAR_KEYS[key];
  const press = char !== undefined
    ? `keystroke "${char === '\\' ? '\\\\' : char}"`
    : (CODE_KEYS[key] !== undefined ? `key code ${CODE_KEYS[key]}` : null);
  if (!press) return null;
  return `tell application "System Events" to ${press}${using}`;
}

module.exports = {
  name: 'darwin',
  prettyName: 'macOS',
  autostartLabel: 'Start at login',
  setupCommand: 'npm run setup',
  setupScript: 'install.sh',

  pythonPath: () => path.join(ROOT, '.venv', 'bin', 'python3'),

  launchAppTarget: () => `${path.join(ROOT, 'launch-app.sh')} %s`,

  commandExample: '/usr/bin/open -a TextEdit %s',

  capabilities() {
    // `false` asks without prompting — the prompt belongs to an explicit user
    // action, not to every launch. Unpackaged runs report against the Electron
    // binary, which is the thing macOS is actually being asked to trust.
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    return {
      paste: trusted,
      shortcut: trusted,
      keys: trusted,
      // A CGEventTap could hold the keyboard back while a combination is
      // recorded, the way the Windows hook does. There is no such helper here
      // yet, so a combination the system already uses does its usual thing as
      // well as being recorded.
      suppressKeys: false,
      warnings: trusted ? [] : [
        'Accessibility permission is not granted, so the global shortcut and '
        + 'auto-paste will not work. Grant it in System Settings → Privacy & '
        + 'Security → Accessibility, then restart the app.',
      ],
    };
  },

  // Prompts for Accessibility if it has not been granted. Called from the
  // settings window, never on startup.
  requestPermission() {
    return systemPreferences.isTrustedAccessibilityClient(true);
  },

  paste: () => new Promise((resolve) => {
    execFile('osascript', ['-e', PASTE_SCRIPT], () => resolve());
  }),

  typeText: (text) => new Promise((resolve, reject) => {
    // The script goes in over stdin (`osascript -`) rather than as -e: a
    // transcript has no length limit worth trusting to an argument list.
    const child = execFile('osascript', ['-'], (err) => (err ? reject(err) : resolve()));
    child.stdin.end(
      `tell application "System Events" to keystroke ${appleScriptString(text)}`,
      'utf8',
    );
  }),

  sendChord: ({ mods, key }) => new Promise((resolve, reject) => {
    const script = chordScript(mods, key);
    if (!script) { reject(new Error(`macOS has no key to press for "${key}".`)); return; }
    execFile('osascript', ['-e', script], (err) => (err ? reject(err) : resolve()));
  }),

  ducking: {
    supported: true,
    scope: 'system',
    note: 'On macOS this turns the whole output volume down, not each app '
      + 'separately — the notification tones are quietened with it.',
    command: (pythonPath) => ({
      file: pythonPath,
      args: [path.join(ROOT, 'audio', 'ducker.py')],
    }),
  },

  autostart: {
    supported: true,
    apply(enabled) {
      // Unpackaged, the login item has to name the Electron binary plus this
      // directory, the same problem Windows has. Packaged, the bundle path in
      // `process.execPath` is enough on its own.
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: app.isPackaged ? ['--hidden'] : [ROOT, '--hidden'],
      });
    },
    enabled() {
      return app.getLoginItemSettings().openAtLogin;
    },
  },

  onReady() {
    // A tray app with no dock icon: the settings window is reachable from the
    // menu bar, and a bouncing dock icon for something you talk to is noise.
    if (app.dock) app.dock.hide();
  },

  tuneOverlay(win) {
    // Without this the pill vanishes the moment you switch to a fullscreen app
    // — which is exactly when you are most likely to be dictating.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  },
};
