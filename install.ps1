# Sets up Screen Prompt 2: node modules for the Electron shell, and a Python
# virtual environment for the Parakeet v2 transcriber.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== npm dependencies ==" -ForegroundColor Cyan
if (-not (Test-Path "node_modules")) {
    npm install
} else {
    Write-Host "node_modules already present, skipping."
}

# Electron 43 fetches its ~100 MB binary lazily on first use rather than from a
# postinstall hook, so `npm install` finishing does not mean it is ready. Pull it
# here, where a download is expected, instead of letting the first `npm start`
# stall with no explanation.
node -e "require('electron')"
if (-not $?) { Write-Host "(Electron binary will download on first start instead.)" }

Write-Host "== Python environment ==" -ForegroundColor Cyan
$python = $null
foreach ($candidate in @("py -3", "python")) {
    try {
        $ver = Invoke-Expression "$candidate --version" 2>$null
        if ($ver -match "Python 3\.(1[0-9]|[2-9][0-9])") { $python = $candidate; break }
    } catch {}
}
if (-not $python) {
    Write-Host "Python 3.10+ not found. Install it from python.org and re-run." -ForegroundColor Red
    exit 1
}

# Tested on the interpreter rather than the directory: a checkout shared with
# WSL or a Linux dual boot already has a .venv, but with the bin/ layout this
# cannot use. Recreating it is the right move there.
if (-not (Test-Path ".venv\Scripts\python.exe")) {
    if (Test-Path ".venv") { Remove-Item -Recurse -Force ".venv" }
    Invoke-Expression "$python -m venv .venv"
}
& ".venv\Scripts\python.exe" -m pip install --upgrade pip
& ".venv\Scripts\python.exe" -m pip install "onnx-asr[cpu,hub]>=0.6.0"

# Verified rather than assumed. An environment that is missing one package does
# not complain until the app starts, and then it names whichever module happened
# to be imported first — which is how a half-finished install reports itself as
# "No module named huggingface_hub" regardless of what actually went wrong.
$importError = & ".venv\Scripts\python.exe" -c "import onnx_asr, huggingface_hub" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "The Python environment did not finish installing:" -ForegroundColor Red
    $importError | Select-Object -Last 3
    Write-Host "Run this by hand to see the full error:" -ForegroundColor Red
    Write-Host "  .venv\Scripts\python.exe -m pip install ""onnx-asr[cpu,hub]>=0.6.0""" -ForegroundColor Red
    exit 1
}
Write-Host "Python environment OK." -ForegroundColor Green

Write-Host "== Launcher ==" -ForegroundColor Cyan
# A double-clickable exe so the app can be started from Explorer or the taskbar
# rather than from a terminal that then has to stay open. Not fatal if it fails:
# `npm start` is unaffected, and the reason is printed above.
node scripts/make-launcher.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "The launcher did not build; use 'npm start' instead." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Start the app by double-clicking 'Screen Prompt 2.exe'," -ForegroundColor Green
Write-Host "or with: npm start" -ForegroundColor Green
Write-Host "The Parakeet v2 model (~600 MB quantized) downloads on first launch."
