#!/usr/bin/env bash
# Launches an installed app by partial name — the macOS/Linux counterpart of
# launch-app.ps1, so "Launch Spotify" starts Spotify on any platform.
#
# Use it as a "Run a command" target:
#   /path/to/launch-app.sh %s
#
# The spoken name arrives as bound arguments, never interpolated into a command
# string, so nothing you say is ever parsed as shell. That is the same reason
# the Windows version is a file rather than a -Command one-liner.
#
# Exit codes match launch-app.ps1: 1 empty query, 2 no match, 3 launch failed.

set -uo pipefail
shopt -s nocasematch nullglob

query="$*"
query="${query#"${query%%[![:space:]]*}"}"   # trim leading space
query="${query%"${query##*[![:space:]]}"}"   # trim trailing space
[[ -z $query ]] && exit 1

best=""        # what to launch (a .app path, or a .desktop file)
best_label=""  # its human name, for the error and for shortest-match scoring

# Shortest matching name wins, so "word" prefers Word over WordPad — the same
# tie-break the PowerShell version uses.
consider() {
  local label="$1" target="$2"
  [[ $label == *"$query"* ]] || return 0
  if [[ -z $best || ${#label} -lt ${#best_label} ]]; then
    best="$target"
    best_label="$label"
  fi
}

if [[ $OSTYPE == darwin* ]]; then
  # Depth 2 so /Applications/Utilities/Terminal.app is found as well.
  for dir in /Applications /System/Applications "$HOME/Applications"; do
    [[ -d $dir ]] || continue
    while IFS= read -r app; do
      name="$(basename "$app" .app)"
      consider "$name" "$app"
    done < <(find "$dir" -maxdepth 2 -name '*.app' 2>/dev/null)
  done

  [[ -z $best ]] && { echo "No app matching \"$query\" in Applications." >&2; exit 2; }
  open -a "$best" || { echo "Could not start $best_label." >&2; exit 3; }
  exit 0
fi

# Linux: XDG desktop entries are the equivalent of the Start menu. Later
# directories win on a filename clash, which is why user entries are read last.
for dir in \
  /usr/share/applications \
  /usr/local/share/applications \
  /var/lib/flatpak/exports/share/applications \
  "${XDG_DATA_HOME:-$HOME/.local/share}/applications" \
  "$HOME/.local/share/flatpak/exports/share/applications"
do
  [[ -d $dir ]] || continue
  for entry in "$dir"/*.desktop; do
    # Only the [Desktop Entry] group matters; actions further down the file
    # have their own Name= keys ("New Window") that would match wrongly.
    group="$(sed -n '/^\[Desktop Entry\]/,/^\[/p' "$entry")"
    [[ $group == *"NoDisplay=true"* || $group == *"Hidden=true"* ]] && continue
    name="$(printf '%s\n' "$group" | sed -n 's/^Name=//p' | head -n 1)"
    [[ -n $name ]] && consider "$name" "$entry"
  done
done

[[ -z $best ]] && { echo "No app matching \"$query\" installed." >&2; exit 2; }

# gio and gtk-launch both honour the entry properly — startup notification, the
# right working directory, Terminal=true. Parsing Exec= by hand is the fallback
# for minimal systems that have neither.
if command -v gio >/dev/null 2>&1; then
  gio launch "$best" >/dev/null 2>&1 && exit 0
elif command -v gtk-launch >/dev/null 2>&1; then
  gtk-launch "$(basename "$best" .desktop)" >/dev/null 2>&1 && exit 0
else
  exec_line="$(sed -n '/^\[Desktop Entry\]/,/^\[/p' "$best" | sed -n 's/^Exec=//p' | head -n 1)"
  # Strip the field codes (%u %U %f %F %i %c %k) the spec says to substitute;
  # left in, they would be passed to the app as literal arguments.
  exec_line="$(printf '%s\n' "$exec_line" | sed 's/%[uUfFickdDnNvm]//g')"
  [[ -z $exec_line ]] && { echo "Could not start $best_label: no Exec line." >&2; exit 3; }
  # shellcheck disable=SC2086  # word splitting is the point: Exec is a command line
  setsid $exec_line >/dev/null 2>&1 < /dev/null &
  exit 0
fi

echo "Could not start $best_label." >&2
exit 3
