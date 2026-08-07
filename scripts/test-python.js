// Runs the Python-side tests, when there is a Python to run them with.
//
// Skipped rather than failed on a checkout that has not been set up yet, so
// `npm test` still works immediately after cloning — the JavaScript suites do
// not need the virtualenv and should not be held hostage to it.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const python = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python3');

if (!fs.existsSync(python)) {
  console.log('skipping ducking tests — no .venv yet (run `npm run setup`)');
  process.exit(0);
}

const result = spawnSync(python, [path.join(root, 'audio', 'ducker_test.py')],
  { stdio: 'inherit', cwd: root });

if (result.error) {
  console.error(`could not run the ducking tests: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
