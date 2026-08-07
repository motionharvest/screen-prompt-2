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
import re
import shutil
import subprocess
import sys


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
            target = [str(max(0, round(v * level))) for v in stream["volumes"]]
            # One value per channel, so a stream whose channels sat at different
            # volumes keeps that balance instead of being flattened.
            run(["pactl", "set-sink-input-volume", stream["index"], *target])
            # Saved unconditionally: a successful set prints nothing, so the
            # output cannot distinguish success from failure, and restoring a
            # stream that was never turned down is harmless.
            self.saved.append((stream["index"], stream["volumes"]))
        return len(self.saved)

    def restore(self) -> None:
        for index, volumes in self.saved:
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
        self.original = current
        self._set(round(current * level))
        return 1

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

    emit({"event": "status", "state": "ready", "scope": ducker.scope})

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
                    emit({"event": "ducked", "sessions": count})
                elif req.get("cmd") == "restore":
                    ducker.restore()
                    emit({"event": "restored"})
            except Exception as exc:  # never let one bad command kill the loop
                emit({"event": "error", "detail": str(exc)})
    finally:
        try:
            ducker.restore()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
