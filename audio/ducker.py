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
          each stream separately and restores each to its own original volume,
          matching what the Windows helper does.

  macOS   osascript, which can only reach the *system* output volume. macOS has
          no public per-application volume API — there is no equivalent of the
          Core Audio session mixer — so ducking there is all-or-nothing, and
          this app's own tones are turned down with everything else.

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
    every stream quiet with no record of where it came from — and both
    PulseAudio (module-stream-restore) and macOS remember a volume once set, so
    the ducked value silently becomes the new normal and the next recording
    multiplies it down again.
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

    Every caller treats failure as "this stream is gone" — an app that quit
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


class PulseDucker:
    """Per-stream ducking through pactl."""

    scope = "per-app"

    def __init__(self) -> None:
        # index -> [raw volume per channel], captured at duck time.
        self.saved: list[tuple[str, list[int]]] = []

    @staticmethod
    def available() -> bool:
        return shutil.which("pactl") is not None

    def _streams(self) -> list[dict]:
        """[{index, volumes:[int], binary, role}] for every playback stream."""
        # -f json landed in pactl 15 (2021). Older distributions still ship 13,
        # so the human-readable format is parsed as a fallback rather than
        # making this a hard version requirement.
        raw = run(["pactl", "-f", "json", "list", "sink-inputs"])
        if raw:
            try:
                return [
                    {
                        "index": str(s["index"]),
                        "volumes": [int(c["value"]) for c in s["volume"].values()],
                        "binary": (s.get("properties") or {}).get(
                            "application.process.binary", ""
                        ),
                        "role": (s.get("properties") or {}).get("media.role", ""),
                    }
                    for s in json.loads(raw)
                ]
            except (ValueError, KeyError, TypeError):
                pass  # fall through to the text parser
        return self._streams_from_text()

    @staticmethod
    def _streams_from_text() -> list[dict]:
        raw = run(["pactl", "list", "sink-inputs"])
        streams = []
        for block in re.split(r"\n(?=Sink Input #)", raw):
            index = re.match(r"Sink Input #(\d+)", block)
            if not index:
                continue
            # "Volume: front-left: 65536 / 100% / 0.00 dB, front-right: ..."
            line = re.search(r"^\s*Volume:(.*)$", block, re.M)
            volumes = [int(v) for v in re.findall(r":\s*(\d+)\s*/", line.group(1))] if line else []
            if not volumes:
                continue
            binary = re.search(r'application\.process\.binary = "([^"]*)"', block)
            role = re.search(r'media\.role = "([^"]*)"', block)
            streams.append({
                "index": index.group(1),
                "volumes": volumes,
                "binary": binary.group(1) if binary else "",
                "role": role.group(1) if role else "",
            })
        return streams

    def duck(self, level: float, skip_name: str) -> int:
        self.restore()
        for stream in self._streams():
            # Our own tones come from a Chromium audio-service child process,
            # which reports the same binary name as the main one — so matching
            # on the name exempts the whole tree, as it does on Windows.
            if skip_name and stream["binary"] == skip_name:
                continue
            # The counterpart of skipping the Windows system-sounds session:
            # desktop blips are too short to be worth talking over.
            if stream["role"] == "event":
                continue
            # Compared against the level applied to *full scale*, not to this
            # stream's own volume. A stream already at or below where a
            # full-volume one would be put is quiet enough already, and ducking
            # it again would record the ducked value as its original — which is
            # how one lost restore turns into silence a recording at a time.
            # Rounded the same way the value was written, or a stream sitting at
            # exactly the ducked volume reads as one unit above the threshold
            # and gets ducked again.
            if all(v <= round(level * FULL_SCALE) for v in stream["volumes"]):
                continue

            floor = MIN_DUCKED * FULL_SCALE
            target = [max(int(floor), round(v * level)) for v in stream["volumes"]]
            # One value per channel, so a stream whose channels sat at different
            # volumes keeps that balance instead of being flattened.
            #
            # Recorded before the write: a successful set prints nothing, so the
            # output cannot distinguish success from failure, and a stream left
            # out of `saved` is a stream that never gets put back.
            self.saved.append((stream["index"], stream["volumes"], stream["binary"]))
            run(["pactl", "set-sink-input-volume", stream["index"],
                 *[str(t) for t in target]])
        return len(self.saved)

    def state(self) -> list:
        return [
            {"index": index, "volumes": volumes, "binary": binary}
            for index, volumes, binary in self.saved
        ]

    def recover(self, entries: list) -> int:
        """Put back volumes a previous process never got to restore.

        Matched on the binary name rather than the sink-input index: the index
        belongs to a stream, and the stream this is rescuing may well have been
        torn down and recreated since — which is exactly the case where
        stream-restore has already reapplied the ducked volume to it.
        """
        wanted: dict[str, list[int]] = {}
        for entry in entries:
            binary = str(entry.get("binary") or "")
            volumes = entry.get("volumes")
            if binary and isinstance(volumes, list) and volumes:
                wanted[binary] = [int(v) for v in volumes]

        restored = 0
        for stream in self._streams():
            original = wanted.get(stream["binary"])
            if not original:
                continue
            # Only raise. Something louder than the value being put back has
            # legitimately changed since, and pulling it down would be wrong.
            if all(c >= o for c, o in zip(stream["volumes"], original)):
                continue
            run(["pactl", "set-sink-input-volume", stream["index"],
                 *[str(v) for v in original]])
            restored += 1
        return restored

    def restore(self) -> None:
        for index, volumes, _binary in self.saved:
            run(["pactl", "set-sink-input-volume", index, *[str(v) for v in volumes]])
        self.saved.clear()


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
        # Already at or below the target: see the note in PulseDucker.duck —
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
            # Only raise, for the same reason as the per-app back-ends.
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
        ducker: PulseDucker | SystemVolumeDucker = SystemVolumeDucker()
        missing = "osascript not found."
    else:
        ducker = PulseDucker()
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
