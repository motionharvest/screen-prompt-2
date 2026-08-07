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

Write-Host ""
Write-Host "Done. Start the app with: npm start" -ForegroundColor Green
Write-Host "The Parakeet v2 model (~600 MB quantized) downloads on first launch."
