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

# Electron 43 fetches its ~100 MB binary lazily on first use rather than from a
# postinstall hook, so `npm install` finishing does not mean it is ready. Pull it
# here, where a download is expected, instead of letting the first `npm start`
# stall with no explanation.
node -e "require('electron')" \
  || echo "(Electron binary will download on first start instead.)"

cyan "== Python environment =="

# Most distributions split venv and pip out of the base python3 package. Left to
# itself the failure is an ensurepip traceback or "No module named pip", neither
# of which names the thing you actually have to install — so name it here.
py_packages_hint() {
  if command -v apt-get >/dev/null 2>&1; then
    echo "sudo apt install python3-venv python3-pip"
  elif command -v dnf >/dev/null 2>&1; then
    echo "sudo dnf install python3-pip"
  elif command -v pacman >/dev/null 2>&1; then
    echo "sudo pacman -S python-pip"
  elif command -v zypper >/dev/null 2>&1; then
    echo "sudo zypper install python3-pip python3-virtualenv"
  elif command -v apk >/dev/null 2>&1; then
    echo "sudo apk add python3 py3-pip"
  elif [[ $OSTYPE == darwin* ]]; then
    echo "brew install python@3.12"
  else
    echo "install your distribution's python3-venv and python3-pip packages"
  fi
}

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
  red "  $(py_packages_hint)"
  exit 1
fi
echo "Using $python ($("$python" --version 2>&1))"

# Tested on the interpreter rather than the directory: a checkout shared with
# Windows (WSL, a dual boot, a synced folder) already has a .venv, but with the
# Scripts/ layout this cannot use. Recreating it is the right move there.
if [[ ! -x .venv/bin/python ]]; then
  # Unconditional, not guarded by a test: under `set -e` a failing `[[ ]] &&`
  # list would end the script when there is simply nothing to remove.
  rm -rf .venv
  # The error is shown rather than swallowed: it usually names the missing
  # module, which is the fastest route to the right package.
  if ! "$python" -m venv .venv; then
    red "Could not create the virtual environment."
    red "  $(py_packages_hint)"
    exit 1
  fi
fi

# Creating the venv normally bootstraps pip into it through ensurepip. Where
# ensurepip is packaged separately the venv is created *successfully* but has no
# pip, and the first sign of that is the install below failing — so check here,
# where the message can still be useful.
if ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
  .venv/bin/python -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
if ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
  red "The virtual environment was created but has no pip in it."
  red "  $(py_packages_hint)"
  red "Then delete .venv and re-run: rm -rf .venv && npm run setup"
  exit 1
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
