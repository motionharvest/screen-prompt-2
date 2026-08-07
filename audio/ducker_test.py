"""Tests for the ducking helper. Run with `npm test`.

Ducking is the one feature here that changes state outside the app and has to
put it back. When it fails to, the result is silent and cumulative: the ducked
volume becomes the application's remembered volume, and the next recording
multiplies it down again until everything is inaudible. Every case below is a
step on that path.

pactl and osascript are never invoked — `run` is replaced with a fake, so this
tests the logic on any machine, including the Windows one it was written on.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ducker", os.path.join(HERE, "ducker.py"))
ducker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ducker)

FIXTURE = """Sink Input #12
\tMute: no
\tVolume: front-left: 45875 /  70% / -9.29 dB,   front-right: 65536 / 100% / 0.00 dB
\tProperties:
\t\tapplication.process.binary = "firefox"

Sink Input #13
\tMute: no
\tVolume: mono: 32768 /  50% / -18.06 dB
\tProperties:
\t\tmedia.role = "event"
\t\tapplication.process.binary = "gsd-media-keys"

Sink Input #14
\tMute: no
\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
\tProperties:
\t\tapplication.process.binary = "electron"
"""

# A system already turned down to 5% — what a helper that was killed mid-duck
# leaves behind.
DUCKED_FIXTURE = """Sink Input #12
\tMute: no
\tVolume: front-left: 3277 /  5% / -26.02 dB,   front-right: 3277 / 5% / -26.02 dB
\tProperties:
\t\tapplication.process.binary = "firefox"
"""

failures = []


def check(name, got, want):
    if got != want:
        failures.append(f"FAIL  {name}\n      expected {want}\n      got      {got}")


def fake_run(fixture, log=None):
    def run(argv):
        if log is not None:
            log.append(argv)
        if argv[:3] == ["pactl", "-f", "json"]:
            return ""          # force the text parser, as on older pactl
        if argv[:2] == ["pactl", "list"]:
            return fixture
        return ""
    return run


# -- parsing ----------------------------------------------------------------

ducker.run = fake_run(FIXTURE)
streams = ducker.PulseDucker._streams_from_text()
check("parses every stream", len(streams), 3)
check("keeps per-channel volumes", streams[0]["volumes"], [45875, 65536])
check("reads the binary name", streams[0]["binary"], "firefox")
check("reads the media role", streams[1]["role"], "event")

# -- ducking ----------------------------------------------------------------

log = []
ducker.run = fake_run(FIXTURE, log)
d = ducker.PulseDucker()
n = d.duck(0.25, "electron")
sets = [c for c in log if len(c) > 1 and c[1] == "set-sink-input-volume"]
check("ducks only the one eligible stream", n, 1)
check("skips event sounds and our own process, keeps balance",
      sets, [["pactl", "set-sink-input-volume", "12", "11469", "16384"]])

log.clear()
d.restore()
check("restores the exact originals",
      log, [["pactl", "set-sink-input-volume", "12", "45875", "65536"]])

# -- the floor ---------------------------------------------------------------

log.clear()
ducker.run = fake_run(FIXTURE, log)
d = ducker.PulseDucker()
d.duck(0.0, "electron")          # asked for silence
sets = [c for c in log if len(c) > 1 and c[1] == "set-sink-input-volume"]
floor = str(int(ducker.MIN_DUCKED * 65536))
check("never writes true silence, even at level 0",
      sets, [["pactl", "set-sink-input-volume", "12", floor, floor]])

# -- the anti-compounding guard ---------------------------------------------

log.clear()
ducker.run = fake_run(DUCKED_FIXTURE, log)
d = ducker.PulseDucker()
n = d.duck(0.05, "electron")
sets = [c for c in log if len(c) > 1 and c[1] == "set-sink-input-volume"]
check("does not re-duck an already-ducked stream", n, 0)
check("...and writes nothing at all", sets, [])

# -- crash recovery ----------------------------------------------------------

def writes(log):
    """Just the volume changes — enumerating is not a side effect worth asserting."""
    return [c for c in log if len(c) > 1 and c[1] == "set-sink-input-volume"]


log.clear()
ducker.run = fake_run(DUCKED_FIXTURE, log)
d = ducker.PulseDucker()
restored = d.recover([{"binary": "firefox", "volumes": [45875, 65536]}])
check("recovers a stream a dead process left ducked", restored, 1)
check("...back to the recorded originals",
      writes(log), [["pactl", "set-sink-input-volume", "12", "45875", "65536"]])

log.clear()
ducker.run = fake_run(FIXTURE, log)
d = ducker.PulseDucker()
restored = d.recover([{"binary": "firefox", "volumes": [1000, 1000]}])
check("only raises — never pulls down a stream that is already louder",
      (restored, writes(log)), (0, []))

log.clear()
ducker.run = fake_run(DUCKED_FIXTURE, log)
d = ducker.PulseDucker()
check("ignores entries for applications that are not running",
      d.recover([{"binary": "spotify", "volumes": [65536, 65536]}]), 0)

# -- the state file ----------------------------------------------------------

ducker.run = fake_run(FIXTURE)
d = ducker.PulseDucker()
d.duck(0.25, "electron")
state = d.state()
check("state carries what recovery needs",
      state, [{"index": "12", "volumes": [45875, 65536], "binary": "firefox"}])

with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "nested", "duck-state.json")
    ducker.state_path = lambda: path
    ducker.save_state(state)
    check("state survives a round trip through disk", ducker.load_state(), state)
    ducker.clear_state()
    check("clearing removes the file", os.path.exists(path), False)
    check("a missing file reads as nothing to recover", ducker.load_state(), [])
    # Saving nothing must not leave a stale file claiming otherwise.
    ducker.save_state(state)
    ducker.save_state([])
    check("saving an empty state clears the file", os.path.exists(path), False)

if failures:
    print("\n".join(failures))
    print(f"\n{len(failures)} failed")
    sys.exit(1)
print("all ducking checks passed")
