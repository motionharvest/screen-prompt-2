// Windows adapter. This is the platform the app was written on, so everything
// here is the original implementation with the paths and comments intact.

const path = require('path');
const { execFile, spawn } = require('child_process');
const { app } = require('electron');

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

// The registry value name. Without this Electron falls back to the app user
// model id, which for an unpackaged app is the generic `electron.app.Electron`
// — every unpackaged Electron app on the machine would fight over that one
// entry, and it tells you nothing in Task Manager's Startup tab.
const LOGIN_ITEM_NAME = 'Screen Prompt 2';

// Windows runs the login item as a bare command line, so an unpackaged app has
// to spell out electron.exe plus this directory — `process.execPath` alone
// would launch Electron with no app to run. Paths are quoted because the
// registry value is one string that Windows re-splits on spaces.
function loginItemArgs() {
  const args = ['--hidden'];
  if (!app.isPackaged) args.unshift(`"${ROOT}"`);
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
  capabilities: () => ({ paste: true, shortcut: true, warnings: [] }),

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

  shutdown() {
    if (typer) { try { typer.stdin.end(); } catch { /* already gone */ } }
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
