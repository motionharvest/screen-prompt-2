"""Volume ducking helper for macOS and Linux.

Speaks exactly the protocol audio/ducker.ps1 speaks on Windows, so main.js
does not care which one it started:

    in   {"cmd":"duck","level":0.25,"skipName":"electron"}   {"cmd":"restore"}
    out  {"event":"status","state":"ready"}   {"event":"ducked","sessions":3}

Python rather than a shell script because the protocol is JSON and both
back-ends need to do arithmetic on volumes they read back — and because the
venv interpreter is already a hard dependency for transcription, so this adds
nothing to install.

Two back-ends, picked by platform:

  Linux   pactl, which drives PulseAudio and PipeWire's pulse shim alike. Ducks
          the default output device as a whole; PulseSinkDucker explains why
          not each stream.

  macOS   osascript, which can only reach the *system* output volume. macOS has
          no public per-application volume API — there is no equivalent of the
          Core Audio session mixer.

Both therefore duck the whole output, and this app's own tones are turned down
with everything else while a recording runs.

Like the Windows helper, the read loop ends when stdin closes and the `finally`
restores on the way out, so killing the app mid-recording can never leave the
system turned down.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys

# Nothing is turned down below this, whatever the level asks for. If the
# originals are ever lost the volumes cannot then be walked to true silence one
# recording at a time — the damage stays bounded at something still audible.
MIN_DUCKED = 0.02

# PulseAudio expresses 100% as 65536, so fractions are scaled against that.
FULL_SCALE = 65536


def state_path() -> str:
    """Where the originals are parked while ducked.

    They live on disk as well as in memory because in memory they die with this
    process, and the `finally` in the read loop only covers a clean stop. A
    kill, a crash, or the machine going down mid-recording would otherwise leave
    the output quiet with no record of where it came from — and both PulseAudio
    and macOS keep an output volume once set, so the ducked value silently
    becomes the new normal and the next recording multiplies it down again.
    """
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "Screen Prompt 2", "duck-state.json")


def save_state(entries: list) -> None:
    try:
        path = state_path()
        if not entries:
            clear_state()
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(entries, fh)
    except OSError:
        pass  # ducking still works this run; only crash recovery is lost


def load_state() -> list:
    try:
        with open(state_path(), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def clear_state() -> None:
    try:
        os.remove(state_path())
    except OSError:
        pass


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def run(argv: list[str]) -> str:
    """Capture stdout, or "" if the command fails.

    Every caller treats failure as "this device is gone" — an output unplugged
    while ducked takes its volume with it, so failing to restore it is the
    correct outcome rather than an error worth reporting.
    """
    try:
        out = subprocess.run(
            argv, capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout if out.returncode == 0 else ""


# ------------------------------------------------------------------- Linux --


class PulseSinkDucker:
    """System-wide ducking through pactl: the default output device, not each app.

    Per-stream ducking was tried first and fails in a way the user cannot see
    or undo. PulseAudio's module-stream-restore remembers a volume against a
    key such as the application name or media role, and saves it the moment it
    is set. A stream that ends while ducked — a notification, a short clip,
    anything that plays and exits within one recording — takes its index with
    it, so the restore has nothing to write to, and the ducked value is left
    behind as that key's remembered volume. Every later stream with the same
    key then starts quiet, and most desktops show no per-app slider to raise it.

    The output device has neither problem. It outlives any recording, it is the
    volume the desktop's own control already shows, and it is one value to put
    back. The cost is that this app's own tones are turned down with it; main.js
    holds the duck back until the start tone has finished for that reason.
    """

    scope = "system"

    def __init__(self) -> None:
        # (sink name, [raw volume per channel]) captured at duck time.
        self.saved: tuple[str, list[int]] | None = None

    @staticmethod
    def available() -> bool:
        return shutil.which("pactl") is not None

    @staticmethod
    def _default_sink() -> str:
        """The default sink's name, or the alias pactl resolves itself.

        The name is kept rather than the alias so that switching output device
        mid-recording — headphones connecting, say — restores the device that
        was actually ducked, instead of writing its volume onto the new one.
        get-default-sink landed in pactl 15; older versions get the alias.
        """
        return run(["pactl", "get-default-sink"]).strip() or "@DEFAULT_SINK@"

    @staticmethod
    def _volumes(sink: str) -> list[int]:
        # "Volume: front-left: 36638 /  56% / -15.15 dB,   front-right: ..."
        raw = run(["pactl", "get-sink-volume", sink])
        return [int(v) for v in re.findall(r":\s*(\d+)\s*/", raw)]

    @staticmethod
    def _set(sink: str, volumes: list[int]) -> None:
        # One value per channel, so a device whose channels sat at different
        # volumes keeps that balance instead of being flattened.
        run(["pactl", "set-sink-volume", sink, *[str(v) for v in volumes]])

    def duck(self, level: float, _skip_name: str) -> int:
        self.restore()
        sink = self._default_sink()
        current = self._volumes(sink)
        if not current:
            return 0
        floor = int(MIN_DUCKED * FULL_SCALE)
        target = [max(floor, round(v * level)) for v in current]
        # Already at or below the target: recording a ducked value as the
        # original is what makes a lost restore permanent and compounding.
        if all(t >= c for t, c in zip(target, current)):
            return 0
        # Recorded before the write: a successful set prints nothing, so the
        # output cannot distinguish success from failure, and a volume left out
        # of `saved` is a volume that never gets put back.
        self.saved = (sink, current)
        self._set(sink, target)
        return 1

    def state(self) -> list:
        if self.saved is None:
            return []
        sink, volumes = self.saved
        return [{"sink": sink, "volumes": volumes}]

    def recover(self, entries: list) -> int:
        """Put back a volume a previous process never got to restore.

        Entries without a sink are skipped: they were written by the old
        per-stream helper, and there is no stream left to aim them at.
        """
        restored = 0
        for entry in entries:
            sink = str(entry.get("sink") or "")
            original = entry.get("volumes")
            if not sink or not isinstance(original, list) or not original:
                continue
            original = [int(v) for v in original]
            current = self._volumes(sink)
            # Gone (unplugged since), or already louder than the value being
            # put back — someone raised it by hand, and pulling it down would
            # be wrong.
            if not current or all(c >= o for c, o in zip(current, original)):
                continue
            self._set(sink, original)
            restored += 1
        return restored

    def restore(self) -> None:
        if self.saved is not None:
            self._set(*self.saved)
            self.saved = None


# ------------------------------------------------------------------ macOS --


class SystemVolumeDucker:
    """System-wide ducking through osascript. See the module docstring."""

    scope = "system"

    def __init__(self) -> None:
        self.original: int | None = None

    @staticmethod
    def available() -> bool:
        return shutil.which("osascript") is not None

    @staticmethod
    def _get() -> int | None:
        raw = run(["osascript", "-e", "output volume of (get volume settings)"]).strip()
        # Returns "missing value" for output devices that expose no software
        # volume control — some USB interfaces and most HDMI outputs.
        try:
            return int(raw)
        except ValueError:
            return None

    @staticmethod
    def _set(value: int) -> None:
        run(["osascript", "-e", f"set volume output volume {max(0, min(100, value))}"])

    def duck(self, level: float, _skip_name: str) -> int:
        self.restore()
        current = self._get()
        if current is None:
            return 0
        target = max(int(MIN_DUCKED * 100), round(current * level))
        # Already at or below the target: see the note in PulseSinkDucker.duck —
        # recording a ducked value as the original is what makes a lost restore
        # permanent and compounding.
        if target >= current:
            return 0
        self.original = current
        self._set(target)
        return 1

    def state(self) -> list:
        return [] if self.original is None else [{"output": self.original}]

    def recover(self, entries: list) -> int:
        for entry in entries:
            original = entry.get("output")
            if not isinstance(original, (int, float)):
                continue
            current = self._get()
            # Only raise, for the same reason as the Linux back-end.
            if current is not None and current >= original:
                continue
            self._set(int(original))
            return 1
        return 0

    def restore(self) -> None:
        if self.original is not None:
            self._set(self.original)
            self.original = None


def main() -> int:
    if sys.platform == "darwin":
        ducker: PulseSinkDucker | SystemVolumeDucker = SystemVolumeDucker()
        missing = "osascript not found."
    else:
        ducker = PulseSinkDucker()
        missing = "pactl not found — install PulseAudio or PipeWire utilities."

    if not ducker.available():
        emit({"event": "status", "state": "error", "detail": missing})
        return 1

    # Recovery runs before anything else touches the volumes, so a duck arriving
    # immediately afterwards reads true originals rather than the previous run's
    # ducked ones. The file is dropped either way: a state file that cannot be
    # applied is worse than none, because it would be retried on every launch.
    recovered = 0
    previous = load_state()
    if previous:
        try:
            recovered = ducker.recover(previous)
        except Exception as exc:  # noqa: BLE001 - never block startup on this
            emit({"event": "error", "detail": f"Could not recover volumes: {exc}"})
        finally:
            clear_state()

    emit({"event": "status", "state": "ready",
          "scope": ducker.scope, "recovered": recovered})

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                continue
            try:
                if req.get("cmd") == "duck":
                    level = min(1.0, max(0.0, float(req.get("level", 0.25))))
                    count = ducker.duck(level, str(req.get("skipName") or ""))
                    # Written before acknowledging: if this process dies in the
                    # next instant, the file is what puts the volumes back.
                    save_state(ducker.state())
                    emit({"event": "ducked", "sessions": count})
                elif req.get("cmd") == "restore":
                    ducker.restore()
                    clear_state()
                    emit({"event": "restored"})
            except Exception as exc:  # never let one bad command kill the loop
                emit({"event": "error", "detail": str(exc)})
    finally:
        try:
            ducker.restore()
        except Exception:
            pass
        clear_state()
    return 0


if __name__ == "__main__":
    sys.exit(main())
