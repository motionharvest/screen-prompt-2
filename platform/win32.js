// Windows adapter. This is the platform the app was written on, so everything
// here is the original implementation with the paths and comments intact.

const path = require('path');
const { execFile, spawn } = require('child_process');
const { app } = require('electron');
const { UiohookKey } = require('uiohook-napi');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------ typing helper --

// type-text.ps1 is kept alive rather than spawned per transcript. Starting it
// costs ~400 ms (PowerShell's own startup plus compiling the interop), and
// paying that between "transcribed" and "text appears" would undo the point;
// once warm a line costs about 5 ms. Started lazily, so the cost is only paid
// by people who actually choose type mode.
let typer = null;
let typerBuf = '';
const typerPending = [];

function startTyper() {
  if (typer) return;
  typer = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'type-text.ps1'),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  typer.stdout.setEncoding('utf8');
  typer.stdout.on('data', (chunk) => {
    typerBuf += chunk;
    let idx;
    while ((idx = typerBuf.indexOf('\n')) >= 0) {
      const line = typerBuf.slice(0, idx).trim();
      typerBuf = typerBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // The ready line answers nobody; every other line answers one request,
      // in order, which is what keeps this queue honest.
      if (msg.event === 'status') continue;
      const waiter = typerPending.shift();
      if (!waiter) continue;
      if (msg.event === 'error') waiter.reject(new Error(msg.detail || 'typing failed'));
      else waiter.resolve();
    }
  });
  typer.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.error('[type]', line.slice(0, 300));
  });

  const fail = (err) => {
    typer = null;
    typerBuf = '';
    while (typerPending.length) typerPending.shift().reject(err);
  };
  typer.on('error', fail);
  typer.on('exit', () => fail(new Error('The typing helper stopped.')));
}

// ------------------------------------------------------------ key combos --

// uiohook keycodes are set-1 scan codes with the extended prefix folded into
// the high byte, which is exactly what SendInput wants once the two are pulled
// apart again. 0x0E and 0xE0 both mark an extended key; 0xEE marks the numpad
// keys that share a scan code with the extended ones and are not extended.
function scanOf(keycode) {
  const prefix = (keycode >> 8) & 0xff;
  return { scan: keycode & 0xff, extended: prefix === 0x0e || prefix === 0xe0 };
}

// Which physical modifier a chord's `ctrl` means. The left-hand one in every
// case: applications match the modifier, not the side it came from.
const MOD_KEYS = {
  ctrl: 0x001d, alt: 0x0038, shift: 0x002a, meta: 0x0e5b,
};

// The same decomposition read backwards, so a scan code arriving from the
// keyboard hook can be named the way the rest of the app names keys. Where two
// uiohook keycodes decompose to the same scan code they are the same physical
// key under two names, and the first one is as good as the other.
const KEYCODE_BY_SCAN = new Map();
for (const keycode of Object.values(UiohookKey)) {
  const { scan, extended } = scanOf(keycode);
  const id = `${scan}:${extended}`;
  if (!KEYCODE_BY_SCAN.has(id)) KEYCODE_BY_SCAN.set(id, keycode);
}

// ------------------------------------------------------- keyboard grabbing --

// grab-keys.ps1 holds the keyboard back while a combination is being recorded.
// Kept warm for the same reason the typing helper is: compiling the hook costs
// most of a second, and paying that after the click means the first keys go to
// the shell instead of to the recording. The hook itself is only installed
// between `grab` and `release`, so the warm process sits there doing nothing
// until a recording asks for it.
let grabber = null;
let grabBuf = '';
let onGrabKey = null;
const grabWaiters = new Map();   // event name -> [{resolve, reject}]

function grabWait(event) {
  return new Promise((resolve, reject) => {
    if (!grabWaiters.has(event)) grabWaiters.set(event, []);
    grabWaiters.get(event).push({ resolve, reject });
  });
}

function grabSettle(event, err) {
  const waiters = grabWaiters.get(event) || [];
  grabWaiters.set(event, []);
  for (const waiter of waiters) (err ? waiter.reject(err) : waiter.resolve());
}

function startGrabber() {
  if (grabber) return;
  grabber = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'grab-keys.ps1'),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  grabber.stdout.setEncoding('utf8');
  grabber.stdout.on('data', (chunk) => {
    grabBuf += chunk;
    let idx;
    while ((idx = grabBuf.indexOf('\n')) >= 0) {
      const line = grabBuf.slice(0, idx).trim();
      grabBuf = grabBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event === 'key') {
        const keycode = KEYCODE_BY_SCAN.get(`${msg.scan}:${Boolean(msg.extended)}`);
        if (keycode !== undefined && onGrabKey) onGrabKey({ down: msg.down, keycode });
      } else if (msg.event === 'status') {
        if (msg.state === 'ready') grabSettle('ready');
        else grabSettle('ready', new Error(msg.detail || 'The key recorder would not start.'));
      } else if (msg.event === 'grabbed' || msg.event === 'released') {
        grabSettle(msg.event);
      } else if (msg.event === 'error') {
        grabSettle('grabbed', new Error(msg.detail || 'The keyboard could not be held.'));
      }
    }
  });
  grabber.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.error('[grab]', line.slice(0, 300));
  });

  const fail = (err) => {
    grabber = null;
    grabBuf = '';
    for (const event of [...grabWaiters.keys()]) grabSettle(event, err);
  };
  grabber.on('error', fail);
  grabber.on('exit', () => fail(new Error('The key recorder stopped.')));
}

// The registry value name. Without this Electron falls back to the app user
// model id, which for an unpackaged app is the generic `electron.app.Electron`
// — every unpackaged Electron app on the machine would fight over that one
// entry, and it tells you nothing in Task Manager's Startup tab.
const LOGIN_ITEM_NAME = 'Screen Prompt 2';

// Windows runs the login item as a bare command line, so an unpackaged app has
// to spell out electron.exe plus this directory — `process.execPath` alone
// would launch Electron with no app to run. The path is passed bare because
// Electron quotes each argument itself when it writes the registry value;
// quoting it here as well puts literal quote marks inside the path.
function loginItemArgs() {
  const args = ['--hidden'];
  if (!app.isPackaged) args.unshift(ROOT);
  return args;
}

module.exports = {
  name: 'win32',
  prettyName: 'Windows',
  autostartLabel: 'Start with Windows',
  setupCommand: 'npm run setup',
  setupScript: 'install.ps1',

  pythonPath: () => path.join(ROOT, '.venv', 'Scripts', 'python.exe'),

  // The keyword target that turns "Launch Spotify" into a running Spotify.
  launchAppTarget: () =>
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(ROOT, 'launch-app.ps1')}" %s`,

  commandExample: 'C:\\Windows\\notepad.exe %s',

  // Nothing to check: the hook and SendKeys both work without the user having
  // to grant anything first.
  capabilities: () => ({
    paste: true, shortcut: true, keys: true, suppressKeys: true, warnings: [],
  }),

  // SendKeys via cscript: starts in ~150 ms and needs no native module. The
  // overlay never takes focus, so the target app still owns the caret.
  paste: () => new Promise((resolve) => {
    execFile('cscript', ['//nologo', path.join(ROOT, 'paste.vbs')],
      { windowsHide: true }, () => resolve());
  }),

  // SendInput with KEYEVENTF_UNICODE, not SendKeys. SendKeys resolves each
  // character through the current keyboard layout, which silently drops the
  // curly apostrophes and em dashes the tidying leaves in the transcript.
  typeText: (text) => new Promise((resolve, reject) => {
    startTyper();
    if (!typer) { reject(new Error('Could not start the typing helper.')); return; }
    typerPending.push({ resolve, reject });
    try {
      typer.stdin.write(`${JSON.stringify({ text })}\n`, 'utf8');
    } catch (err) {
      typerPending.pop();
      reject(err);
    }
  }),

  // Down the same warm pipe as typeText, so a keyword's combination costs one
  // SendInput call rather than a fresh PowerShell.
  sendChord: ({ mods, keycode }) => new Promise((resolve, reject) => {
    startTyper();
    if (!typer) { reject(new Error('Could not start the typing helper.')); return; }
    const chord = {
      ...scanOf(keycode),
      mods: mods.map((mod) => scanOf(MOD_KEYS[mod])),
    };
    typerPending.push({ resolve, reject });
    try {
      typer.stdin.write(`${JSON.stringify({ chord })}\n`, 'utf8');
    } catch (err) {
      typerPending.pop();
      reject(err);
    }
  }),

  // Resolves once the keyboard is actually being held, so the window can wait
  // before it says it is recording. Until then a key would still reach the
  // shell, and a recording that captured it would be telling you it had been
  // suppressed when it had not.
  async grabKeyboard(onKey) {
    onGrabKey = onKey;
    const wasRunning = Boolean(grabber);
    startGrabber();
    if (!grabber) throw new Error('Could not start the key recorder.');
    if (!wasRunning) await grabWait('ready');
    const grabbed = grabWait('grabbed');
    grabber.stdin.write('grab\n');
    await grabbed;
  },

  releaseKeyboard() {
    onGrabKey = null;
    if (!grabber) return;
    try { grabber.stdin.write('release\n'); } catch { /* already gone */ }
  },

  shutdown() {
    if (typer) { try { typer.stdin.end(); } catch { /* already gone */ } }
    // Closing stdin is what the helper watches for: it drops the hook and
    // exits rather than waiting to be killed with the keyboard still held.
    if (grabber) { try { grabber.stdin.end(); } catch { /* already gone */ } }
  },

  ducking: {
    supported: true,
    // Per-app: each session is turned down and put back individually.
    scope: 'per-app',
    note: null,
    // PowerShell because the Core Audio session API is COM-only — a native Node
    // addon would need a build toolchain on every machine that installs this.
    command: () => ({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'audio', 'ducker.ps1')],
    }),
  },

  autostart: {
    supported: true,
    apply(enabled) {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        name: LOGIN_ITEM_NAME,
        path: process.execPath,
        args: loginItemArgs(),
      });
      // An earlier build wrote the entry under the default generic name;
      // leaving it behind would start a second copy at every login.
      app.setLoginItemSettings({ openAtLogin: false });
    },
    // Windows is the authority here — the user may have turned the entry off in
    // Task Manager's Startup tab, which never touches our settings file.
    enabled() {
      return app.getLoginItemSettings({
        name: LOGIN_ITEM_NAME,
        path: process.execPath,
        args: loginItemArgs(),
      }).openAtLogin;
    },
  },
};
