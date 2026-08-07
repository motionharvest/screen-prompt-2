# Launches a Start-menu app by partial name — a keyword target for Screen
# Prompt 2, so "Open Spotify" starts Spotify.
#
# Use it as a "Run a command" target:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File <path>\launch-app.ps1 %s
#
# The spoken name arrives as a bound parameter rather than interpolated into a
# script, so nothing you say is ever parsed as PowerShell. That is the whole
# reason this is a file instead of a -Command one-liner: keyword commands run
# without a shell, and a one-liner would need the query pasted into its source.

param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Name)

$query = (($Name -join ' ')).Trim()
if (-not $query) { exit 1 }

# Shortest matching name wins, so "word" prefers Word over WordPad.
$app = Get-StartApps |
  Where-Object { $_.Name -like "*$query*" } |
  Sort-Object { $_.Name.Length } |
  Select-Object -First 1

if (-not $app) {
  [Console]::Error.WriteLine("No app matching ""$query"" in the Start menu.")
  exit 2
}

try {
  # Get-StartApps returns two different kinds of AppID. Packaged apps get an
  # AppUserModelID ("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"), which only
  # the AppsFolder shell namespace can resolve. Plain Win32 entries — Spotify,
  # Python, anything installed the old way — get the executable's own path,
  # and handing *that* to shell:AppsFolder makes explorer shrug and exit 0.
  # That silent success is exactly how this failed the first time.
  if (Test-Path -LiteralPath $app.AppID) {
    Start-Process -FilePath $app.AppID
  } else {
    explorer.exe "shell:AppsFolder\$($app.AppID)"
  }
} catch {
  [Console]::Error.WriteLine("Could not start $($app.Name): $($_.Exception.Message)")
  exit 3
}
