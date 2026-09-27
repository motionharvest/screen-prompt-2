// Installs the Linux launcher: a .desktop entry in the user's applications
// directory, which is what puts "Screen Prompt 2" in the app menu, the
// launcher search and the dock. It is the Linux counterpart of the Windows
// exe that scripts/make-launcher.js compiles, and it makes the same choice:
// the entry starts Electron from this checkout rather than from a packaged
// build, so `git pull` updates the app and nothing has to be reinstalled.
//
// Nothing is compiled. A desktop entry is a text file, and the menu picks it
// up as soon as it is written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
const ICON = path.join(ROOT, 'assets', 'icon.png');

// Named after package.json's "name" on purpose. Electron reports that name,
// plus ".desktop", as the window's app id, and the dock uses the match to put
// the running window under this entry's icon rather than a generic one.
const APPS_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'applications',
);
const ENTRY = path.join(APPS_DIR, 'screen-prompt-2.desktop');

// An Exec= value is parsed twice. The key file format unescapes backslashes
// first; the Exec rules then split on spaces, where a quoted argument must
// backslash its ", `, $ and \. So one backslash in a path becomes four.
function execArg(arg) {
  if (!/[\s"'`$\\<>~|&;*?#()]/.test(arg)) return arg;
  const quoted = `"${arg.replace(/["`$\\]/g, '\\$&')}"`;
  return quoted.replace(/\\/g, '\\\\');
}

// Other string values only go through the key file unescaping.
function value(text) {
  return text.replace(/\\/g, '\\\\');
}

function build() {
  if (!fs.existsSync(ELECTRON)) {
    // The entry would install fine and then do nothing when clicked, which is
    // the failure most worth catching here instead.
    console.error('Electron is not installed in this folder yet. Run:');
    console.error('    npm install');
    console.error('    npm run setup');
    process.exit(1);
  }

  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Screen Prompt 2',
    'GenericName=Dictation',
    'Comment=Push-to-talk dictation',
    `Exec=${execArg(ELECTRON)} ${execArg(ROOT)}`,
    `Path=${value(ROOT)}`,
    'Terminal=false',
    'Categories=Utility;Accessibility;',
    'Keywords=dictation;speech;transcribe;voice;',
    'StartupWMClass=screen-prompt-2',
    // Started a second time from the menu, the app already running in the
    // tray: a separate action, so the plain entry keeps opening the window.
    'Actions=hidden;',
  ];
  if (fs.existsSync(ICON)) {
    lines.push(`Icon=${value(ICON)}`);
  } else {
    console.warn(`No ${ICON}; the entry will use the desktop's default icon.`);
  }
  lines.push(
    '',
    '[Desktop Action hidden]',
    'Name=Start in the tray',
    `Exec=${execArg(ELECTRON)} ${execArg(ROOT)} --hidden`,
    '',
  );

  fs.mkdirSync(APPS_DIR, { recursive: true });
  fs.writeFileSync(ENTRY, lines.join('\n'));

  // Both tools are optional. The validator catches an entry the menu would
  // silently skip; the database refresh just makes some menus notice sooner.
  try {
    execFileSync('desktop-file-validate', [ENTRY], { stdio: 'inherit' });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`\n${ENTRY} did not validate; the menu may ignore it.`);
      process.exit(1);
    }
  }
  try {
    execFileSync('update-desktop-database', [APPS_DIR], { stdio: 'ignore' });
  } catch { /* not installed, or nothing to do */ }

  console.log(`Installed ${ENTRY}`);
  console.log('Screen Prompt 2 is now in your app menu; it lives in the tray from there.');
  console.log('Run this again if you move this folder.');
}

module.exports = { build, execArg };

if (require.main === module) build();
