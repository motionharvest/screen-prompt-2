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
