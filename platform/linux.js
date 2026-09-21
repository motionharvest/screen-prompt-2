// Linux adapter.
//
// Linux is the only platform where the tools this needs might genuinely not be
// installed, so nothing here assumes: the paste helper is resolved by looking
// down PATH at startup and reported through `capabilities()`, rather than
// failing silently at the moment you first try to dictate.
//
// The session protocol matters more than the distribution. Under X11 everything
// works. Under Wayland the compositor deliberately stops one client from
// reading another's keystrokes or typing into it, which is the whole point of
// Wayland's input model — so both the global shortcut and auto-paste depend on
// tools that route around it (wtype talks the virtual-keyboard protocol,
// ydotool goes through /dev/uinput below the display server entirely).

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');

const IS_WAYLAND = process.env.XDG_SESSION_TYPE === 'wayland'
  || Boolean(process.env.WAYLAND_DISPLAY);

// Cheaper and more predictable than shelling out to `which`, which may not be
// installed and would cost a process spawn per candidate.
function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch { /* next */ }
  }
  return false;
}

// Canonical key name to X keysym. xdotool and wtype both name keys this way,
// so one table serves both; only the modifier spellings differ, below.
const KEYSYMS = {
  enter: 'Return', tab: 'Tab', space: 'space', backspace: 'BackSpace',
  escape: 'Escape', delete: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  arrowleft: 'Left', arrowup: 'Up', arrowright: 'Right', arrowdown: 'Down',
  semicolon: 'semicolon', equal: 'equal', comma: 'comma', minus: 'minus',
  period: 'period', slash: 'slash', backquote: 'grave',
  bracketleft: 'bracketleft', backslash: 'backslash', bracketright: 'bracketright',
  quote: 'apostrophe',
  capslock: 'Caps_Lock', numlock: 'Num_Lock', scrolllock: 'Scroll_Lock',
  printscreen: 'Print',
  ctrl: 'Control_L', alt: 'Alt_L', shift: 'Shift_L', meta: 'Super_L',
  numpadenter: 'KP_Enter', numpadadd: 'KP_Add', numpadsubtract: 'KP_Subtract',
  numpadmultiply: 'KP_Multiply', numpaddivide: 'KP_Divide',
  numpaddecimal: 'KP_Decimal',
};
for (let i = 0; i <= 9; i += 1) KEYSYMS[`numpad${i}`] = `KP_${i}`;
for (let i = 1; i <= 24; i += 1) KEYSYMS[`f${i}`] = `F${i}`;

// Letters and digits are their own keysym, so they need no table.
function keysym(key) {
  return /^[a-z0-9]$/.test(key) ? key : KEYSYMS[key];
}

// Each entry is a way to reach the focused window: `paste` sends Ctrl+V,
// `type` enters the text itself, `chord` sends one key combination. Every one
// of these takes the text as a single bound argument, so nothing in a
// transcript is ever parsed as shell.
const INPUT_TOOLS = [
  // Wayland's virtual-keyboard protocol. -M holds a modifier, -m releases it.
  {
    bin: 'wtype',
    wayland: true,
    x11: false,
    paste: ['-M', 'ctrl', 'v', '-m', 'ctrl'],
    type: (text) => ['--', text],
    // Modifiers down, the key, modifiers back up in reverse — wtype has no
    // combination syntax, it has a stream of press and release instructions.
    chord: (mods, key) => [
      ...mods.flatMap((mod) => ['-M', WTYPE_MODS[mod]]),
      '-k', key,
      ...[...mods].reverse().flatMap((mod) => ['-m', WTYPE_MODS[mod]]),
    ],
  },
  // Writes to /dev/uinput, so it is below the display server and works on
  // both — at the cost of needing the daemon running and uinput permissions.
  // Raw evdev codes: 29 is left ctrl, 47 is V; :1 is press, :0 is release.
  {
    bin: 'ydotool',
    wayland: true,
    x11: true,
    paste: ['key', '29:1', '47:1', '47:0', '29:0'],
    type: (text) => ['type', '--', text],
    // No chord support: ydotool names keys by raw evdev number, and a table of
    // those would be a third naming of the same keyboard maintained by hand.
    // wtype and xdotool both take keysyms, so one of those is the answer here.
    chord: null,
  },
  // XTEST. --clearmodifiers stops a modifier you are still holding from
  // turning Ctrl+V into some other chord.
  {
    bin: 'xdotool',
    wayland: false,
    x11: true,
    paste: ['key', '--clearmodifiers', 'ctrl+v'],
    // A small delay per key: at 0 some applications drop characters, because
    // XTEST can deliver them faster than the client reads its event queue.
    type: (text) => ['type', '--clearmodifiers', '--delay', '4', '--', text],
    chord: (mods, key) => ['key', '--clearmodifiers',
      [...mods.map((mod) => XDOTOOL_MODS[mod]), key].join('+')],
  },
];

const WTYPE_MODS = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'logo' };
const XDOTOOL_MODS = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super' };

// Resolved once: PATH does not change under a running app, and this is on the
// path between "transcribed" and "text appears".
let inputTool;
function resolveInputTool() {
  if (inputTool === undefined) {
    inputTool = INPUT_TOOLS.find(
      (t) => (IS_WAYLAND ? t.wayland : t.x11) && onPath(t.bin),
    ) || null;
  }
  return inputTool;
}

const AUTOSTART_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'autostart',
);
const AUTOSTART_FILE = path.join(AUTOSTART_DIR, 'screen-prompt-2.desktop');

module.exports = {
  name: 'linux',
  prettyName: 'Linux',
  autostartLabel: 'Start at login',
  setupCommand: 'npm run setup',
  setupScript: 'install.sh',

  pythonPath: () => path.join(ROOT, '.venv', 'bin', 'python3'),

  launchAppTarget: () => `${path.join(ROOT, 'launch-app.sh')} %s`,

  commandExample: '/usr/bin/gedit %s',

  capabilities() {
    const tool = resolveInputTool();
    const warnings = [];

    if (!tool) {
      const wanted = IS_WAYLAND ? 'wtype (or ydotool)' : 'xdotool (or ydotool)';
      warnings.push(
        `No paste helper found on PATH. Install ${wanted} to have transcripts `
        + 'typed into the focused app; without it they are still copied to the '
        + 'clipboard and you can paste them yourself.',
      );
    }
    if (IS_WAYLAND) {
      warnings.push(
        'On Wayland the global shortcut only sees keys pressed in XWayland '
        + 'windows, because the compositor does not let one app read another\'s '
        + 'input. Log in to an X11 session for a shortcut that works '
        + 'everywhere.',
      );
    }
    if (tool && !tool.chord) {
      warnings.push(
        `Key-combination keywords need wtype or xdotool. ${tool.bin} is what was `
        + 'found on PATH, and it names keys by raw event code rather than by '
        + 'name, so a combination cannot be sent through it.',
      );
    }
    return {
      paste: Boolean(tool),
      shortcut: !IS_WAYLAND,
      keys: Boolean(tool && tool.chord),
      // An X11 keyboard grab would hold the keys back while a combination is
      // recorded, the way the Windows hook does. There is no such helper here
      // yet, so a combination the desktop already uses does its usual thing as
      // well as being recorded.
      suppressKeys: false,
      warnings,
    };
  },

  paste: () => new Promise((resolve, reject) => {
    const tool = resolveInputTool();
    if (!tool) {
      reject(new Error('No paste helper installed — the text is on the clipboard.'));
      return;
    }
    execFile(tool.bin, tool.paste, () => resolve());
  }),

  typeText: (text) => new Promise((resolve, reject) => {
    const tool = resolveInputTool();
    if (!tool) {
      reject(new Error('No input helper installed — install xdotool, wtype or ydotool.'));
      return;
    }
    execFile(tool.bin, tool.type(text), (err) => (err ? reject(err) : resolve()));
  }),

  sendChord: ({ mods, key }) => new Promise((resolve, reject) => {
    const tool = resolveInputTool();
    if (!tool || !tool.chord) {
      reject(new Error('No helper that can send key combinations — install wtype or xdotool.'));
      return;
    }
    const sym = keysym(key);
    if (!sym) { reject(new Error(`No X keysym for "${key}".`)); return; }
    execFile(tool.bin, tool.chord(mods, sym), (err) => (err ? reject(err) : resolve()));
  }),

  ducking: {
    supported: true,
    // pactl talks to PulseAudio and to PipeWire's pulse shim, so one code path
    // covers effectively every current desktop.
    scope: 'per-app',
    note: 'Needs pactl (PulseAudio or PipeWire).',
    command: (pythonPath) => ({
      file: pythonPath,
      args: [path.join(ROOT, 'audio', 'ducker.py')],
    }),
  },

  autostart: {
    // Electron's setLoginItemSettings is a no-op on Linux, so this writes the
    // XDG autostart entry itself. Every mainstream desktop reads this
    // directory; the file being present is the whole state.
    supported: true,
    apply(enabled) {
      if (!enabled) {
        try { fs.unlinkSync(AUTOSTART_FILE); } catch { /* already gone */ }
        return;
      }
      const exec = app.isPackaged
        ? `"${process.execPath}" --hidden`
        : `"${process.execPath}" "${ROOT}" --hidden`;
      fs.mkdirSync(AUTOSTART_DIR, { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE, [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Screen Prompt 2',
        'Comment=Push-to-talk dictation',
        `Exec=${exec}`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n'));
    },
    enabled() {
      return fs.existsSync(AUTOSTART_FILE);
    },
  },
};
