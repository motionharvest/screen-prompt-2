// `npm run setup` on any platform. npm has no conditional script syntax, so
// this dispatches to install.ps1 or install.sh and forwards the exit code.

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

const [file, args] = process.platform === 'win32'
  ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(root, 'install.ps1')]]
  // Invoked through bash rather than executed directly, so a checkout that
  // lost its executable bit (a zip download, or a clone on a filesystem that
  // does not carry the bit) still installs.
  : ['bash', [path.join(root, 'install.sh')]];

const result = spawnSync(file, args, { stdio: 'inherit', cwd: root });

if (result.error) {
  console.error(`Could not run the installer: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
