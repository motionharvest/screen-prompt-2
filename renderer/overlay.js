// Overlay renderer: microphone capture at 16 kHz, live spectrum, and the
// start/stop/done tones. The window is click-through and never focused, so
// everything here is display and audio only.

const pill = document.getElementById('pill');
const label = document.getElementById('label');
const canvas = document.getElementById('spectrum');
const ctx2d = canvas.getContext('2d');

// ------------------------------------------------------------------ tones --

// Tone sequences carried over from screen-prompt's sound.py: rising to begin,
// falling to end, a little triad when the text is ready.
const TONES = {
  start: [[784, 70], [1175, 90]],
  stop: [[1175, 70], [784, 90]],
  cancel: [[523, 60], [392, 130]],
  done: [[1047, 60], [1319, 60], [1568, 110]],
  error: [[330, 160], [247, 240]],
};

let toneCtx = null;
function playTones(name, enabled) {
  if (!enabled) return;
  if (!toneCtx) toneCtx = new AudioContext();
  if (toneCtx.state === 'suspended') toneCtx.resume();
  let t = toneCtx.currentTime + 0.02;
  for (const [freq, ms] of TONES[name]) {
    const dur = ms / 1000;
    const osc = toneCtx.createOscillator();
    const gain = toneCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.008);
    gain.gain.setValueAtTime(0.22, t + dur - 0.02);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain).connect(toneCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
    t += dur;
  }
}

// ---------------------------------------------------------------- capture --

const TARGET_RATE = 16000;

// How much of the audio from just *before* the shortcut registered is kept.
//
// This was 300 ms when a lone-modifier toggle could only fire on the key
// release, and had to cover however long the key was held — about 120 ms — plus
// the gap before that. The shortcut now fires on the press, so all that is left
// to cover is the hop from the hook through main to this renderer, which is a
// few milliseconds.
//
// Kept rather than removed because that hop is not guaranteed to be fast: under
// load a scheduling hiccup would otherwise clip the first syllable, and the
// buffer costs one small array copy. Short on purpose — every millisecond of
// pre-roll is a millisecond of whatever you said before deciding to dictate.
const PREROLL_MS = 150;
const PREROLL_SAMPLES = (TARGET_RATE * PREROLL_MS) / 1000;

let stream = null;
let audioCtx = null;
let analyser = null;
let workletNode = null;
let chunks = [];        // Float32Array pieces at 16 kHz, this recording
let sampleCount = 0;
let recording = false;
let wantRecording = false;
let liveStream = false; // send PCM to main while recording (Modulate streaming)
let liveFloats = [];
let liveCount = 0;
const LIVE_FLUSH_SAMPLES = 1280; // 80 ms at 16 kHz

function floatToS16le(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

function pushLive(float32) {
  if (!liveStream) return;
  liveFloats.push(float32);
  liveCount += float32.length;
  if (liveCount >= LIVE_FLUSH_SAMPLES) flushLive();
}

function flushLive() {
  if (!liveCount) return;
  const samples = new Float32Array(liveCount);
  let off = 0;
  for (const c of liveFloats) { samples.set(c, off); off += c.length; }
  liveFloats = [];
  liveCount = 0;
  window.api.sendPcm(floatToS16le(samples));
}

function resetLive() {
  liveStream = false;
  liveFloats = [];
  liveCount = 0;
}
let warm = false;       // keep the device open between recordings
let opening = null;     // in-flight ensureCapture(), so two starts share one
let preroll = [];       // rolling pre-PREROLL_MS audio, only while warm + idle
let prerollCount = 0;

// Opening the microphone is the whole delay. getUserMedia negotiates with the
// OS, the AudioContext opens a device at 16 kHz, and addModule fetches and
// compiles the worklet — together a few hundred milliseconds, all of it after
// the pill already said "Listening…". Doing it once and leaving it open is why
// the warm setting exists; this function is idempotent so either path can call
// it without caring which.
async function ensureCapture() {
  if (workletNode) return;
  if (opening) return opening;

  opening = (async () => {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    stream = media;
    // Unplugging the mic ends the track. Tearing down here means the next
    // recording re-acquires rather than capturing silence from a dead device.
    for (const t of media.getTracks()) {
      t.addEventListener('ended', () => { if (!recording) teardownCapture(); });
    }

    // Asking the context for 16 kHz makes Chromium do the resampling; the model
    // gets its native rate without any DSP of our own.
    audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
    const source = audioCtx.createMediaStreamSource(media);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    // The line's height is driven by frequency energy, and this smooths that data
    // across frames inside the analyser itself — the first line of defence against
    // the height jumping around too fast.
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);

    await audioCtx.audioWorklet.addModule('capture-worklet.js');
    const node = new AudioWorkletNode(audioCtx, 'capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
    });
    node.port.onmessage = (e) => {
      if (recording) {
        chunks.push(e.data);
        sampleCount += e.data.length;
        pushLive(e.data);
        return;
      }
      if (!warm) return;
      preroll.push(e.data);
      prerollCount += e.data.length;
      // Drop from the front only while the whole oldest piece is surplus, so
      // the buffer stays at least PREROLL_SAMPLES rather than dipping under it.
      while (preroll.length && prerollCount - preroll[0].length >= PREROLL_SAMPLES) {
        prerollCount -= preroll.shift().length;
      }
    };
    source.connect(node);
    workletNode = node;
  })();

  try {
    await opening;
  } catch (err) {
    teardownCapture();
    throw err;
  } finally {
    opening = null;
  }
}

// Flag flip plus a memcpy of the pre-roll — nothing that can block, which is
// the point: by the time the pill is painted, capture is already live.
function beginRecording() {
  chunks = warm ? preroll : [];
  sampleCount = warm ? prerollCount : 0;
  preroll = [];
  prerollCount = 0;
  recording = true;
  if (liveStream) {
    for (const c of chunks) pushLive(c);
    flushLive();
  }
}

function finishRecording() {
  recording = false;
  const total = new Float32Array(sampleCount);
  let off = 0;
  for (const c of chunks) { total.set(c, off); off += c.length; }
  chunks = [];
  sampleCount = 0;
  if (!warm) teardownCapture();
  return total;
}

function teardownCapture() {
  if (workletNode) { try { workletNode.disconnect(); } catch { } workletNode = null; }
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  analyser = null;
  preroll = [];
  prerollCount = 0;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// --------------------------------------------------------------- spectrum --

let animId = null;
let phase = 'idle'; // idle | recording | processing

// Bar colours come from the stylesheet's --bar-* custom properties, cached
// here because reading computed style every frame would be wasteful. The CSS
// owns the schemes; this only owns how they are painted.
let bars = { top: '#f0a878', bottom: '#d8825a', processing: 'rgba(216,130,90,0.55)', glow: 'none' };

function applyTheme(theme) {
  document.body.dataset.theme = theme || 'default';
  const css = getComputedStyle(document.body);
  const read = (name) => css.getPropertyValue(name).trim();
  bars = {
    top: read('--bar-top'),
    bottom: read('--bar-bottom'),
    processing: read('--bar-processing'),
    glow: read('--bar-glow'),
  };
}

// The spectrum-analyzer bars, drawn as one continuous line instead of 27
// separate rectangles. Each node is exactly what a bar's height used to be —
// the same non-linear sweep across the low bins where speech lives — but the
// tips are joined into a smooth curve rising from a baseline at the bottom of
// the canvas. So it keeps the "how tall things are" readout that worked, just
// as a single sculpted contour that rises and falls in place. Nothing scrolls
// sideways: x is frequency, not time.
const NODES = 27;      // same resolution as the bars had
const AMP_GAIN = 2.2;  // how strongly energy above the noise floor maps to height
const FILL = 0.95;     // fraction of the half-height a full swing reaches
const EASE = 0.22;     // per-frame move toward the new height; lower = calmer
const traceA = new Float32Array(NODES); // smoothed per-node amplitude, 0..1

// Visual noise gate. A cheap microphone holds every band a little above zero,
// so in silence the line hovers instead of resting. Each band therefore learns
// its own background level: the floor drops quickly whenever the band goes
// quieter (so it finds true silence fast) and creeps up only very slowly when
// the band is louder (so your voice, which comes and goes, never gets absorbed
// into it — but a fan that hums constantly does). What is drawn is only the
// energy *above* that floor plus a small margin, renormalised so full-scale
// speech still reaches full height.
const FLOOR_DROP = 0.12;   // per-frame pull down toward a quieter reading
const FLOOR_RISE = 0.004;  // per-frame creep up toward a louder reading
const GATE = 0.05;         // margin above the floor before anything shows
const noiseF = new Float32Array(NODES); // learned background level per band

// One half of the mirrored outline, as a smooth curve through the node points
// (quadratics through segment midpoints — bar tips without the jaggedness).
function traceHalf(pts) {
  ctx2d.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx2d.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx2d.lineTo(last[0], last[1]);
}

function drawFrame() {
  const W = canvas.width, H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);
  const base = H - 3;              // the line rests here and rises from it
  const swing = (H - 6) * FILL;
  const t = performance.now() / 1000;

  const glow = bars.glow && bars.glow !== 'none';
  ctx2d.shadowColor = glow ? bars.glow : 'transparent';
  ctx2d.shadowBlur = glow ? 8 : 0;

  // A horizontal gradient so the line is brightest in the middle, matching the
  // top/bottom bar colours the schemes already define.
  const grad = ctx2d.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, bars.bottom);
  grad.addColorStop(0.5, bars.top);
  grad.addColorStop(1, bars.bottom);
  ctx2d.strokeStyle = phase === 'processing' ? bars.processing : grad;
  ctx2d.lineWidth = 2;
  ctx2d.lineJoin = 'round';
  ctx2d.lineCap = 'round';

  ctx2d.beginPath();
  if (phase === 'recording' && analyser) {
    const freq = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freq);
    const bins = freq.length;
    // Exactly the sweep the bars used: speech lives in the low bins at 16 kHz,
    // sampled non-linearly so the energy spreads across the whole width.
    const pts = [];
    for (let i = 0; i < NODES; i++) {
      const f = i / (NODES - 1);
      const bin = Math.min(bins - 1, Math.floor(Math.pow(f, 1.4) * bins * 0.85));
      const v = freq[bin] / 255;
      // Track this band's background: fast down, very slow up (see above).
      noiseF[i] += (v - noiseF[i]) * (v < noiseF[i] ? FLOOR_DROP : FLOOR_RISE);
      // Only what clears the floor + gate is signal; renormalise the remaining
      // range so loud speech still uses the full height.
      const span = Math.max(0.15, 1 - noiseF[i] - GATE);
      const signal = Math.max(0, v - noiseF[i] - GATE) / span;
      const target = Math.min(1, signal * AMP_GAIN);
      traceA[i] += (target - traceA[i]) * EASE;
      const h = traceA[i] * swing;
      pts.push([f * W, base - h]);
    }
    traceHalf(pts);
  } else if (phase === 'processing') {
    // No microphone here — a gentle travelling swell above the baseline keeps
    // the pill feeling awake. (0.5 + 0.5·sin) keeps it from dipping below.
    const POINTS = 72, HUMPS = 2.6, speed = 5, amp = swing * 0.3;
    for (let i = 0; i <= POINTS; i++) {
      const f = i / POINTS, x = f * W;
      const env = Math.sin(Math.PI * f);
      const lift = 0.5 + 0.5 * Math.sin(f * Math.PI * 2 * HUMPS + t * speed);
      const y = base - lift * amp * env;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
  } else {
    ctx2d.moveTo(0, base);
    ctx2d.lineTo(W, base);
  }
  ctx2d.stroke();
  ctx2d.shadowBlur = 0;
  animId = requestAnimationFrame(drawFrame);
}

function startAnim() { if (animId === null) animId = requestAnimationFrame(drawFrame); }
function stopAnim() {
  if (animId !== null) { cancelAnimationFrame(animId); animId = null; }
  traceA.fill(0);
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

// --------------------------------------------------------------- dragging --

// The pill can be picked up and put somewhere, and where it is dropped is where
// it stays. Only the gesture lives here: whether the window is taking clicks at
// all is decided in main, which watches the pointer against the window's own
// bounds. Deciding it here instead would mean deciding it from the mouse events
// that the decision itself changes, and that loop is not stable.

let dragging = false;

// Pointer capture, so a drag that outruns the window — which it will, since the
// window is only chasing the pointer once per frame — still gets its moves and
// its release here rather than losing them to whatever is underneath.
pill.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  document.body.classList.add('dragging');
  pill.setPointerCapture(e.pointerId);
  window.api.overlayDrag('start');
  e.preventDefault();
});

pill.addEventListener('pointermove', () => {
  if (dragging) window.api.overlayDrag('move');
});

// 'pointerup' and 'pointercancel' both end it. A cancel — the pointer captured
// away by the system — has to leave the pill somewhere rather than dragging for
// ever, and where it is now is the only honest answer.
for (const event of ['pointerup', 'pointercancel']) {
  pill.addEventListener(event, (e) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    try { pill.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    window.api.overlayDrag('end');
  });
}

// ---------------------------------------------------------------- control --

function setPill(cls, text) {
  pill.className = cls;
  label.textContent = text;
}

window.api.onOverlayCmd(async (cmd) => {
  applyTheme(cmd.theme);
  // Every command carries the setting, so the overlay cannot drift out of step
  // with it — the same reason `theme` rides along on all of them.
  const wasWarm = warm;
  warm = Boolean(cmd.warm);
  if (wasWarm && !warm && !recording) teardownCapture();

  switch (cmd.cmd) {
    // 'theme' carries nothing else — it exists so changing the scheme in
    // settings repaints an overlay that is already on screen.
    case 'theme':
      break;

    // The two shapes. Main resizes the window; these two decide what is drawn
    // inside it, and they arrive before the resize so nothing is seen at the
    // wrong size on the way through.
    case 'rest':
      phase = 'idle';
      stopAnim();
      setPill('', '');
      document.body.classList.add('resting');
      break;

    case 'wake':
      document.body.classList.remove('resting');
      break;

    // Sent at launch and whenever the setting is toggled on. Opening the device
    // now is the whole point: it moves the cost off the path between pressing
    // the shortcut and capturing the first sample.
    case 'warm':
      if (warm && !recording) {
        try { await ensureCapture(); } catch { /* reported on first use */ }
      }
      break;

    case 'start':
      setPill('recording', 'Listening…');
      phase = 'recording';
      wantRecording = true;
      liveStream = Boolean(cmd.liveStream);
      liveFloats = [];
      liveCount = 0;
      startAnim();
      playTones('start', cmd.sounds);
      try {
        // Warm, this returns without awaiting anything real and capture is live
        // in this same tick. Cold, the device opens here — the delay the warm
        // setting exists to remove.
        await ensureCapture();
        // A fast toggle can stop the recording while the device is still
        // opening; without this the stream would leak and the mic stay hot.
        if (!wantRecording) {
          resetLive();
          if (!warm) teardownCapture();
          break;
        }
        beginRecording();
      } catch (err) {
        // Main answers with an error cmd, which shows the message and plays
        // the error tone; nothing to display from here.
        wantRecording = false;
        resetLive();
        window.api.sendAudio(new ArrayBuffer(0), 0, true,
          `Microphone unavailable: ${err.message}`);
      }
      break;

    case 'stop': {
      wantRecording = false;
      playTones('stop', cmd.sounds);
      if (liveStream) flushLive();
      const streaming = liveStream;
      resetLive();
      const samples = finishRecording();
      const duration = samples.length / TARGET_RATE;
      phase = 'processing';
      setPill('', 'Transcribing…');
      const wav = streaming ? new ArrayBuffer(0) : encodeWav(samples, TARGET_RATE);
      window.api.sendAudio(wav, duration, false);
      break;
    }

    case 'done':
      phase = 'idle';
      stopAnim();
      // A keyword supplies its own line; otherwise main says which of paste,
      // copy or type actually happened. The transcript itself is deliberately
      // not shown — the pill is too small for it, and it has already landed
      // wherever it was going.
      setPill('done', cmd.label || `✓ ${cmd.verb || 'Copied'}`);
      playTones('done', cmd.sounds);
      break;

    // The press turned out to be part of a combination. Unwind everything with
    // no tone and no message — main hides the window in the same tick, so the
    // only trace should be that nothing happened at all.
    case 'abort':
      wantRecording = false;
      resetLive();
      phase = 'idle';
      stopAnim();
      finishRecording();
      setPill('', '');
      break;

    // Sent both for a recording too short to be meant, where capture has
    // already stopped, and for Escape, where it has not. finishRecording is
    // idempotent, so one branch covers both — and the samples are dropped on
    // the floor rather than sent, which is what makes Escape a real cancel.
    case 'cancel':
      wantRecording = false;
      resetLive();
      finishRecording();
      phase = 'idle';
      stopAnim();
      setPill('', 'Cancelled');
      playTones('cancel', cmd.sounds);
      break;

    case 'error':
      phase = 'idle';
      stopAnim();
      setPill('error', cmd.message || 'Something went wrong');
      playTones('error', cmd.sounds);
      break;
  }
});
