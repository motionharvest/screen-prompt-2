#!/usr/bin/env bash
# Sets up Screen Prompt 2 on macOS and Linux: node modules for the Electron
# shell, and a Python virtual environment for the Parakeet v2 transcriber.
# The counterpart of install.ps1 — `npm run setup` picks whichever fits.

set -euo pipefail
cd "$(dirname "$0")"

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

cyan "== npm dependencies =="
if [[ -d node_modules ]]; then
  echo "node_modules already present, skipping."
else
  npm install
fi

cyan "== Python environment =="
python=""
for candidate in python3.12 python3.11 python3 python; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  # onnx-asr needs 3.10+; anything older cannot install it at all.
  if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    python="$candidate"
    break
  fi
done

if [[ -z $python ]]; then
  red "Python 3.10+ not found. Install it and re-run."
  exit 1
fi

# Tested on the interpreter rather than the directory: a checkout shared with
# Windows (WSL, a dual boot, a synced folder) already has a .venv, but with the
# Scripts/ layout this cannot use. Recreating it is the right move there.
if [[ ! -x .venv/bin/python ]]; then
  # Unconditional, not guarded by a test: under `set -e` a failing `[[ ]] &&`
  # list would end the script when there is simply nothing to remove.
  rm -rf .venv
  # Debian and Ubuntu ship venv separately, and the failure is otherwise a
  # confusing ensurepip traceback rather than a package name you can act on.
  "$python" -m venv .venv 2>/dev/null || {
    red "Could not create .venv. On Debian/Ubuntu: sudo apt install python3-venv"
    exit 1
  }
fi

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install "onnx-asr[cpu,hub]>=0.6.0"

chmod +x launch-app.sh 2>/dev/null || true

cyan "== Optional helpers =="
if [[ $OSTYPE == darwin* ]]; then
  echo "macOS needs Accessibility permission for the global shortcut and"
  echo "auto-paste: System Settings -> Privacy & Security -> Accessibility."
else
  command -v pactl >/dev/null 2>&1 \
    || echo "pactl not found — volume ducking will be unavailable."
  if [[ ${XDG_SESSION_TYPE:-} == wayland || -n ${WAYLAND_DISPLAY:-} ]]; then
    command -v wtype >/dev/null 2>&1 || command -v ydotool >/dev/null 2>&1 \
      || echo "Install wtype (or ydotool) for auto-paste on Wayland."
    echo "Note: on Wayland the global shortcut only sees XWayland windows."
  else
    command -v xdotool >/dev/null 2>&1 || command -v ydotool >/dev/null 2>&1 \
      || echo "Install xdotool (or ydotool) for auto-paste on X11."
  fi
fi

echo
green "Done. Start the app with: npm start"
echo "The Parakeet v2 model (~600 MB quantized) downloads on first launch."
