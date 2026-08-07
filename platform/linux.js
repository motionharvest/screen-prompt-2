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

// Each entry is a way to reach the focused window: `paste` sends Ctrl+V,
// `type` enters the text itself. Every one of these takes the text as a single
// bound argument, so nothing in a transcript is ever parsed as shell.
const INPUT_TOOLS = [
  // Wayland's virtual-keyboard protocol. -M holds a modifier, -m releases it.
  {
    bin: 'wtype',
    wayland: true,
    x11: false,
    paste: ['-M', 'ctrl', 'v', '-m', 'ctrl'],
    type: (text) => ['--', text],
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
  },
];

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
    return { paste: Boolean(tool), shortcut: !IS_WAYLAND, warnings };
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
