# The Windows launcher

`Screen Prompt 2.exe` in the repo root is a 7 KB stub that starts the app and
exits. It exists so the app can be started from Explorer, the taskbar or the
Start menu instead of from a terminal that then has to stay open all session.

It is **not** a packaged build. The app still runs from this checkout, using
this `node_modules` and this `.venv`, so `git pull` updates it and nothing has
to be reinstalled. Moving the exe out of the repo root breaks it — it finds
Electron relative to itself. Make a shortcut instead (right-click → *Send to* →
*Desktop*, or → *Pin to taskbar*).

## Building it

```powershell
npm run launcher
```

`npm run setup` does this for you on Windows. Both are safe to re-run.

The compiler is `csc.exe` from the .NET Framework, which is present on every
Windows since 8 — there is no SDK to install and no npm dependency. The build
output (`Screen Prompt 2.exe`, `launcher/icon.ico`) is generated and therefore
git-ignored; `launcher/launcher.cs` is the source.

## Arguments

Anything passed through reaches Electron, so a shortcut can add `--hidden` to
start straight into the tray with no settings window — the same flag the login
item uses.

## Why an .exe and not a .bat or .vbs

A `.bat` opens a console window that has to stay open for as long as the app
runs. A `.vbs` avoids that but cannot carry an icon, and lands people in
whatever has taken over the `.vbs` association. A GUI-subsystem exe has
neither problem and can show a real message box when `node_modules` is missing,
which is the one failure a new clone actually hits.
