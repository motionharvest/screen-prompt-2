"""Stdio transcription sidecar: NVIDIA Parakeet TDT 0.6B v2 via onnx-asr.

Speaks JSON lines. Emits {"event":"status","state":...} while loading, then
answers {"id":N,"cmd":"transcribe","wav":path} with {"id":N,"text":...}.

Parakeet only accepts 20-30 seconds of audio per call, so recordings longer
than that go through Silero VAD, which splits on natural pauses (the same
arrangement the original screen-prompt used). Short clips skip the VAD for
speed. The model downloads on first use into the Hugging Face cache.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import wave

state: dict = {"model": None, "vad_model": None, "ready": False}
_stdout_lock = threading.Lock()


def emit(obj: dict) -> None:
    with _stdout_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def _install_progress_hook() -> None:
    """Report model-download progress as JSON events.

    huggingface_hub's `snapshot_download` funnels every worker thread's byte
    counts into aggregate progress bars built from its `tqdm_class` argument,
    so a tqdm subclass that emits instead of drawing is the one hook that sees
    the whole download. onnx-asr imports `snapshot_download` at call time,
    which makes the module attribute patchable.
    """
    import huggingface_hub
    from huggingface_hub.utils import tqdm as hf_tqdm

    class JsonTqdm(hf_tqdm):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault("file", open(os.devnull, "w"))
            # Two aggregate bars exist: network transfer and bytes written to
            # disk ("Reconstructing…"). The reconstruct bar advances on both
            # the xet and the plain-HTTP path, so it is the one to report.
            self._track = (
                kwargs.get("unit") == "B"
                and not str(kwargs.get("desc", "")).startswith("Downloading bytes")
            )
            self._done = float(kwargs.get("initial", 0) or 0)
            self._rate = 0.0
            self._mark_t = time.monotonic()
            self._mark_n = self._done
            self._last_emit = 0.0
            self._lock = threading.Lock()
            super().__init__(*args, **kwargs)

        def update(self, n=1):
            if self._track and n:
                with self._lock:
                    self._done += float(n)
                    self._maybe_emit()
            try:
                return super().update(n)
            except Exception:
                return None

        def _maybe_emit(self):
            now = time.monotonic()
            # `snapshot_download` grows `total` as each file registers.
            total = float(getattr(self, "total", 0) or 0)
            finished = total > 0 and self._done >= total
            if not finished and now - self._last_emit < 0.4:
                return
            dt = now - self._mark_t
            if dt > 0.2:
                instant = (self._done - self._mark_n) / dt
                self._rate = instant if self._rate == 0 else 0.7 * self._rate + 0.3 * instant
                self._mark_t, self._mark_n = now, self._done
            self._last_emit = now
            emit({"event": "progress", "done": int(self._done),
                  "total": int(total), "speed": int(self._rate),
                  "finished": finished})

    original = huggingface_hub.snapshot_download

    def snapshot_with_progress(*args, **kwargs):
        kwargs.setdefault("tqdm_class", JsonTqdm)
        return original(*args, **kwargs)

    huggingface_hub.snapshot_download = snapshot_with_progress


def trace(msg: str) -> None:
    print(f"[trace] {msg}", file=sys.stderr, flush=True)


def load(model_name: str, quantization: str) -> None:
    emit({"event": "status", "state": "loading",
          "detail": "Loading model…"})
    try:
        # Best effort, and deliberately not fatal. This only produces the
        # download percentage, and it reaches into huggingface_hub internals
        # that are not a public API — so a version that moves them should cost
        # you the readout, not the ability to transcribe. It also used to be the
        # first third-party import in the process, which meant *any* incomplete
        # environment surfaced as "No module named huggingface_hub" no matter
        # which package was actually missing.
        trace("installing progress hook")
        try:
            _install_progress_hook()
        except Exception as exc:  # noqa: BLE001 - a missing extra is not fatal
            trace(f"progress hook unavailable: {exc!r}")

        trace("importing onnx_asr")
        try:
            import onnx_asr
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                f"The Python environment is incomplete ({exc.name} is missing)."
                " Run `npm run setup` to finish installing it."
            ) from exc

        kwargs = {}
        if quantization:
            kwargs["quantization"] = quantization
        trace("calling load_model")
        model = onnx_asr.load_model(model_name, **kwargs)
        trace("model loaded; loading vad")
        vad = onnx_asr.load_vad("silero")
        state["model"] = model
        state["vad_model"] = model.with_vad(vad)
        state["ready"] = True
        emit({"event": "status", "state": "ready"})
    except Exception as exc:  # noqa: BLE001 - anything here must reach the UI
        emit({"event": "status", "state": "error", "detail": str(exc)})


def wav_seconds(path: str) -> float:
    with wave.open(path, "rb") as wf:
        rate = wf.getframerate() or 1
        return wf.getnframes() / float(rate)


def _item_text(item) -> str:
    if isinstance(item, str):
        return item.strip()
    text = str(getattr(item, "text", "") or "").strip()
    if not text:
        # A VAD segment can wrap the real result rather than being one.
        inner = getattr(item, "result", None)
        if inner is not None:
            text = str(getattr(inner, "text", "") or "").strip()
    return text


def transcribe(path: str, chunk: bool = True) -> str:
    if not state["ready"]:
        raise RuntimeError("model not loaded yet")
    # With chunking off ("skip chunking" in the app), even long clips go to the
    # model in a single pass: no VAD model, no per-segment calls. It is faster,
    # at the cost of accuracy on clips well past Parakeet's ~30s window.
    if not chunk or wav_seconds(path) <= 25.0:
        results = state["model"].recognize(path)
    else:
        results = state["vad_model"].recognize(path)

    if isinstance(results, str):
        items = [results]
    else:
        try:
            items = list(results)
        except TypeError:
            items = [results]

    parts = [t for t in (_item_text(i) for i in items) if t]
    return " ".join(" ".join(parts).split())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="nemo-parakeet-tdt-0.6b-v2")
    parser.add_argument("--quantization", default="int8")
    args = parser.parse_args()

    # Load on the main thread BEFORE touching stdin. On Windows, importing
    # numpy/onnxruntime from a background thread deadlocks while the main
    # thread sits in a blocking stdin read, so the obvious load-in-background
    # arrangement hangs forever. Requests sent while loading simply wait in
    # the pipe buffer until the loop below starts.
    load(args.model, args.quantization)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        req_id = req.get("id")
        if req.get("cmd") == "transcribe":
            try:
                emit({"id": req_id,
                      "text": transcribe(req["wav"], req.get("chunk", True))})
            except Exception as exc:  # noqa: BLE001
                emit({"id": req_id, "error": str(exc)})


if __name__ == "__main__":
    main()
