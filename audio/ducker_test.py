"""Tests for the ducking helper. Run with `npm test`.

Ducking is the one feature here that changes state outside the app and has to
put it back. When it fails to, the result is silent and cumulative: the ducked
volume becomes the output's remembered volume, and the next recording
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

SINK = "alsa_output.pci-0000_00_1f.3.analog-stereo"

# Channels deliberately unequal, so balance is visible in what gets written.
FULL = "Volume: front-left: 45875 /  70% / -9.29 dB,   front-right: 65536 / 100% / 0.00 dB\n        balance -0.30\n"

# An output already at the 2% floor — where repeated lost restores end up.
DUCKED = "Volume: front-left: 1310 /   2% / -101.95 dB,   front-right: 1310 /   2% / -101.95 dB\n        balance 0.00\n"

failures = []


def check(name, got, want):
    if got != want:
        failures.append(f"FAIL  {name}\n      expected {want}\n      got      {got}")


def fake_run(volumes, log=None, sink=SINK):
    """pactl as seen by the helper: `volumes` maps sink name -> get output."""
    if isinstance(volumes, str):
        volumes = {sink: volumes}

    def run(argv):
        if log is not None:
            log.append(argv)
        if argv == ["pactl", "get-default-sink"]:
            return sink + "\n"
        if argv[:2] == ["pactl", "get-sink-volume"]:
            return volumes.get(argv[2], "")
        return ""
    return run


def writes(log):
    """Just the volume changes — reading is not a side effect worth asserting."""
    return [c for c in log if len(c) > 1 and c[1] == "set-sink-volume"]


# -- ducking ----------------------------------------------------------------

log = []
ducker.run = fake_run(FULL, log)
d = ducker.PulseSinkDucker()
n = d.duck(0.25, "electron")
check("ducks the default output once", n, 1)
check("scales each channel, keeping balance",
      writes(log), [["pactl", "set-sink-volume", SINK, "11469", "16384"]])

log.clear()
d.restore()
check("restores the exact originals",
      writes(log), [["pactl", "set-sink-volume", SINK, "45875", "65536"]])

log.clear()
d.restore()
check("a second restore writes nothing", writes(log), [])

# The device that was ducked is the one put back, even if the default moved
# (headphones connected mid-recording).
log.clear()
ducker.run = fake_run(FULL, log)
d = ducker.PulseSinkDucker()
d.duck(0.25, "electron")
ducker.run = fake_run(FULL, log, sink="bluez_output.headphones")
log.clear()
d.restore()
check("restores the device it ducked, not the new default",
      writes(log), [["pactl", "set-sink-volume", SINK, "45875", "65536"]])

# Old pactl without get-default-sink falls back to the alias.
log.clear()
ducker.run = fake_run({"@DEFAULT_SINK@": FULL}, log, sink="")
d = ducker.PulseSinkDucker()
d.duck(0.25, "electron")
check("falls back to @DEFAULT_SINK@ on older pactl",
      writes(log), [["pactl", "set-sink-volume", "@DEFAULT_SINK@", "11469", "16384"]])

# -- the floor ---------------------------------------------------------------

log.clear()
ducker.run = fake_run(FULL, log)
d = ducker.PulseSinkDucker()
d.duck(0.0, "electron")          # asked for silence
floor = str(int(ducker.MIN_DUCKED * 65536))
check("never writes true silence, even at level 0",
      writes(log), [["pactl", "set-sink-volume", SINK, floor, floor]])

# -- the anti-compounding guard ---------------------------------------------

log.clear()
ducker.run = fake_run(DUCKED, log)
d = ducker.PulseSinkDucker()
n = d.duck(0.05, "electron")
check("does not re-duck an output already at the floor", n, 0)
check("...and writes nothing at all", writes(log), [])
check("...and records nothing to restore", d.state(), [])

log.clear()
ducker.run = fake_run("", log)
d = ducker.PulseSinkDucker()
check("an unreadable output is left alone", (d.duck(0.25, ""), writes(log)), (0, []))

# -- crash recovery ----------------------------------------------------------

log.clear()
ducker.run = fake_run(DUCKED, log)
d = ducker.PulseSinkDucker()
restored = d.recover([{"sink": SINK, "volumes": [45875, 65536]}])
check("recovers an output a dead process left ducked", restored, 1)
check("...back to the recorded originals",
      writes(log), [["pactl", "set-sink-volume", SINK, "45875", "65536"]])

log.clear()
ducker.run = fake_run(FULL, log)
d = ducker.PulseSinkDucker()
restored = d.recover([{"sink": SINK, "volumes": [1000, 1000]}])
check("only raises — never pulls down an output that is already louder",
      (restored, writes(log)), (0, []))

log.clear()
ducker.run = fake_run(DUCKED, log)
d = ducker.PulseSinkDucker()
check("ignores an output that is no longer there",
      d.recover([{"sink": "usb_output.unplugged", "volumes": [65536, 65536]}]), 0)

log.clear()
ducker.run = fake_run(DUCKED, log)
d = ducker.PulseSinkDucker()
check("ignores entries left by the old per-stream helper",
      (d.recover([{"index": "12", "binary": "firefox", "volumes": [65536, 65536]}]),
       writes(log)), (0, []))

# -- the state file ----------------------------------------------------------

ducker.run = fake_run(FULL)
d = ducker.PulseSinkDucker()
d.duck(0.25, "electron")
state = d.state()
check("state carries what recovery needs",
      state, [{"sink": SINK, "volumes": [45875, 65536]}])

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
