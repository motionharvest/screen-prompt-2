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
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);

    await audioCtx.audioWorklet.addModule('capture-worklet.js');
    const node = new AudioWorkletNode(audioCtx, 'capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
    });
    node.port.onmessage = (e) => {
      if (recording) {
        chunks.push(e.data);
        sampleCount += e.data.length;
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

const BARS = 27;
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

function drawFrame() {
  const W = canvas.width, H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);
  const gap = 6, bw = (W - gap * (BARS - 1)) / BARS;

  let values = new Array(BARS).fill(0);
  if (phase === 'recording' && analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    // Speech lives in the low bins at 16 kHz; sample them non-linearly so the
    // bars use the whole width instead of crowding the left edge.
    for (let i = 0; i < BARS; i++) {
      const bin = Math.min(data.length - 1, Math.floor(Math.pow(i / BARS, 1.4) * data.length * 0.85));
      values[i] = data[bin] / 255;
    }
  } else if (phase === 'processing') {
    const t = performance.now() / 1000;
    for (let i = 0; i < BARS; i++) {
      values[i] = 0.12 + 0.10 * Math.sin(t * 5 - i * 0.55) ** 2;
    }
  }

  // A scheme can ask for neon by setting --bar-glow; the default one leaves it
  // at `none` and pays nothing for the shadow pass.
  const glow = bars.glow && bars.glow !== 'none';
  ctx2d.shadowColor = glow ? bars.glow : 'transparent';
  ctx2d.shadowBlur = glow ? 10 : 0;

  for (let i = 0; i < BARS; i++) {
    const h = Math.max(4, values[i] * (H - 8));
    const x = i * (bw + gap), y = (H - h) / 2;
    const grad = ctx2d.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, bars.top);
    grad.addColorStop(1, bars.bottom);
    ctx2d.fillStyle = phase === 'processing' ? bars.processing : grad;
    ctx2d.beginPath();
    ctx2d.roundRect(x, y, bw, h, bw / 2);
    ctx2d.fill();
  }
  ctx2d.shadowBlur = 0;
  animId = requestAnimationFrame(drawFrame);
}

function startAnim() { if (animId === null) animId = requestAnimationFrame(drawFrame); }
function stopAnim() {
  if (animId !== null) { cancelAnimationFrame(animId); animId = null; }
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
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
          if (!warm) teardownCapture();
          break;
        }
        beginRecording();
      } catch (err) {
        // Main answers with an error cmd, which shows the message and plays
        // the error tone; nothing to display from here.
        wantRecording = false;
        window.api.sendAudio(new ArrayBuffer(0), 0, true,
          `Microphone unavailable: ${err.message}`);
      }
      break;

    case 'stop': {
      wantRecording = false;
      playTones('stop', cmd.sounds);
      const samples = finishRecording();
      const duration = samples.length / TARGET_RATE;
      phase = 'processing';
      setPill('', 'Transcribing…');
      const wav = encodeWav(samples, TARGET_RATE);
      window.api.sendAudio(wav, duration, false);
      break;
    }

    case 'done':
      phase = 'idle';
      stopAnim();
      // A keyword supplies its own line; otherwise say where the text went.
      // A keyword supplies its own line; otherwise main says which of paste,
      // copy or type actually happened.
      setPill('done', cmd.label || `✓ ${cmd.verb || 'Copied'} — ${cmd.text}`);
      playTones('done', cmd.sounds);
      break;

    // The press turned out to be part of a combination. Unwind everything with
    // no tone and no message — main hides the window in the same tick, so the
    // only trace should be that nothing happened at all.
    case 'abort':
      wantRecording = false;
      phase = 'idle';
      stopAnim();
      finishRecording();
      setPill('', '');
      break;

    case 'cancel':
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
