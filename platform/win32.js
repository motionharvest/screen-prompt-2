// Windows adapter. This is the platform the app was written on, so everything
// here is the original implementation with the paths and comments intact.

const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');

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
