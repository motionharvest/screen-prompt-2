const fs = require('fs');

const MISTRAL_URL = 'https://api.mistral.ai/v1/audio/transcriptions';
const MISTRAL_MODEL = 'voxtral-mini-2602';
const MODULATE_URLS = {
  multilingual: 'https://platform.modulate.ai/api/velma-2-stt-batch',
  fast: 'https://platform.modulate.ai/api/velma-2-stt-batch-multilingual-vfast',
};
const MODULATE_STREAM_URL = 'wss://platform.modulate.ai/api/velma-2-stt-streaming-multilingual-vfast';

function resolveCloudModel(settings) {
  return settings && settings.cloudModel === 'modulate' ? 'modulate' : 'mistral';
}

function resolveModulateMode(settings) {
  const mode = settings && settings.modulateMode;
  if (mode === 'streaming' || mode === 'multilingual') return mode;
  return 'fast';
}

function resolveLocalModel(settings) {
  return settings && settings.localModel === 'nemotron' ? 'nemotron' : 'parakeet';
}

function cloudApiKey(settings) {
  const raw = resolveCloudModel(settings) === 'modulate'
    ? settings && settings.modulateApiKey
    : settings && settings.mistralApiKey;
  return String(raw || '').trim();
}

function transcriptionStatus(settings, sidecar) {
  if (settings && settings.asrProvider === 'cloud') {
    if (cloudApiKey(settings)) return { state: 'ready', detail: '' };
    const name = resolveCloudModel(settings) === 'modulate' ? 'Modulate' : 'Mistral';
    return { state: 'error', detail: `Add a ${name} API key in Processing` };
  }
  return {
    state: sidecar && sidecar.state ? sidecar.state : 'stopped',
    detail: sidecar && sidecar.detail ? sidecar.detail : '',
  };
}

function shouldStartSidecar(provider) {
  return provider !== 'cloud';
}

function shouldStartPythonSidecar(settings) {
  if (!settings || settings.asrProvider === 'cloud') return false;
  return resolveLocalModel(settings) !== 'nemotron';
}

function shouldStartNemotron(settings) {
  if (!settings || settings.asrProvider === 'cloud') return false;
  return resolveLocalModel(settings) === 'nemotron';
}

function isLiveStreaming(settings) {
  if (!settings) return false;
  if (settings.asrProvider !== 'cloud' && resolveLocalModel(settings) === 'nemotron') {
    return true;
  }
  return settings.asrProvider === 'cloud'
    && resolveCloudModel(settings) === 'modulate'
    && resolveModulateMode(settings) === 'streaming'
    && Boolean(cloudApiKey(settings));
}

function nemotronWsUrl(port) {
  return `ws://127.0.0.1:${Number(port) || 18765}/v1/audio/transcriptions/realtime`;
}

function cloudText(body) {
  const direct = String(body && body.text || '').trim();
  if (direct) return direct;
  const segs = body && body.segments;
  if (Array.isArray(segs)) {
    const joined = segs.map((s) => String(s && s.text || '')).join('').trim();
    if (joined) return joined;
  }
  const utts = body && body.utterances;
  if (!Array.isArray(utts)) return '';
  return utts.map((u) => String(u && u.text || '')).join(' ').trim();
}

function apiError(body, fallback) {
  const raw = body && (body.message || body.detail || (body.error && body.error.message));
  if (typeof raw === 'string' && raw) return raw;
  return fallback;
}

function attach(ws, type, fn) {
  if (typeof ws.addEventListener === 'function') ws.addEventListener(type, fn);
  else if (typeof ws.on === 'function') ws.on(type, fn);
  else ws['on' + type] = fn;
}

function messagePayload(event) {
  if (event == null) return '';
  if (typeof event === 'string' || Buffer.isBuffer(event)) return event;
  if (event.data !== undefined) return event.data;
  return event;
}

function closeCode(event) {
  if (typeof event === 'number') return event;
  if (event && typeof event.code === 'number') return event.code;
  return undefined;
}

function streamingCloseMessage(code) {
  if (code === 4001) return 'Invalid API key.';
  if (code === 4003) return 'This request is not permitted.';
  if (code === 4004) return 'This API key does not have access to this model.';
  if (code === 4029) return 'Insufficient credits.';
  if (code === 4030) return 'Concurrent request limit reached.';
  if (code === 4031) return 'Monthly usage limit reached.';
  if (code === 1003) return 'Invalid streaming parameters.';
  if (code === 4002) return 'Streaming audio could not be decoded.';
  return code ? `Modulate streaming closed (${code})` : 'Modulate streaming failed';
}

function payloadText(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return String(raw);
}

async function transcribeMistral(wavPath, apiKey, fetchImpl) {
  const buf = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('model', MISTRAL_MODEL);
  // Without this, Voxtral guesses the language per clip and has returned
  // Cyrillic for English dictation.
  form.append('language', 'en');
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
  const res = await fetchImpl(MISTRAL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    throw new Error(apiError(body, `Mistral returned ${res.status}`));
  }
  return cloudText(body);
}

async function transcribeModulate(wavPath, apiKey, mode, fetchImpl) {
  const url = MODULATE_URLS[mode] || MODULATE_URLS.fast;
  const buf = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('upload_file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
  // Full multilingual defaults diarization on, which is for meetings.
  if (mode === 'multilingual') form.append('speaker_diarization', 'false');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
    body: form,
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    throw new Error(apiError(body, `Modulate returned ${res.status}`));
  }
  return cloudText(body);
}

function openModulateStream(settings, WebSocketImpl = globalThis.WebSocket) {
  if (!WebSocketImpl) throw new Error('Modulate streaming needs a WebSocket');
  const apiKey = cloudApiKey(settings);
  const url = new URL(MODULATE_STREAM_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('audio_format', 's16le');
  url.searchParams.set('sample_rate', '16000');
  url.searchParams.set('num_channels', '1');
  url.searchParams.set('endpointing', 'true');

  let opened = false;
  let ending = false;
  let settled = false;
  const queued = [];
  const parts = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const ws = new WebSocketImpl(url.toString());
  const finish = (err, text) => {
    if (settled) return;
    settled = true;
    try { ws.close(); } catch { /* already closed */ }
    if (err) rejectDone(err);
    else resolveDone(text);
  };

  attach(ws, 'open', () => {
    opened = true;
    for (const buf of queued) ws.send(buf);
    queued.length = 0;
    if (ending) ws.send('');
  });
  attach(ws, 'message', (event) => {
    let msg;
    try { msg = JSON.parse(payloadText(messagePayload(event))); } catch { return; }
    if (msg.type === 'utterance') {
      const t = String(msg.utterance && msg.utterance.text || '').trim();
      if (t) parts.push(t);
    } else if (msg.type === 'done') {
      finish(null, parts.join(' ').trim());
    } else if (msg.type === 'error') {
      finish(new Error(msg.error || 'Modulate streaming failed'));
    }
  });
  attach(ws, 'error', () => finish(new Error('Modulate streaming failed')));
  attach(ws, 'close', (event) => {
    if (settled) return;
    finish(new Error(streamingCloseMessage(closeCode(event))));
  });

  return {
    url: url.toString(),
    send(buf) {
      if (settled || ending || !buf || !buf.byteLength) return;
      if (opened) ws.send(buf);
      else queued.push(buf);
    },
    end() {
      if (settled) return done;
      ending = true;
      if (opened) ws.send('');
      return done;
    },
    abort() {
      finish(new Error('cancelled'));
    },
  };
}

function eventText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const raw = msg.transcript || msg.text || msg.delta
    || (msg.item && (msg.item.transcript || msg.item.text));
  return String(raw || '').trim();
}

function openNemotronStream(port, WebSocketImpl = globalThis.WebSocket) {
  if (!WebSocketImpl) throw new Error('Nemotron streaming needs a WebSocket');
  const url = nemotronWsUrl(port);
  let opened = false;
  let ending = false;
  let settled = false;
  const queued = [];
  const parts = [];
  let partial = '';
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const ws = new WebSocketImpl(url);
  const finish = (err, text) => {
    if (settled) return;
    settled = true;
    try { ws.close(); } catch { /* already closed */ }
    if (err) rejectDone(err);
    else resolveDone(text);
  };
  const transcript = () => (parts.join(' ').trim() || partial).trim();
  const flushAudio = () => {
    opened = true;
    for (const buf of queued) ws.send(buf);
    queued.length = 0;
    if (ending) ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  };

  attach(ws, 'open', () => {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        sample_rate: 16000,
        language: 'auto',
        automatic_punctuation: true,
      },
    }));
    flushAudio();
  });
  attach(ws, 'message', (event) => {
    let msg;
    try { msg = JSON.parse(payloadText(messagePayload(event))); } catch { return; }
    const type = String(msg && msg.type || '');
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const t = eventText(msg);
      if (t) partial = t;
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const t = eventText(msg) || partial;
      if (t) parts.push(t);
      partial = '';
    } else if (type === 'input_audio_buffer.committed') {
      finish(null, transcript());
    } else if (type === 'error') {
      const err = msg.error && (msg.error.message || msg.error);
      finish(new Error(typeof err === 'string' && err ? err : 'Nemotron streaming failed'));
    }
  });
  attach(ws, 'error', () => finish(new Error('Nemotron streaming failed')));
  attach(ws, 'close', () => {
    if (settled) return;
    if (ending) finish(null, transcript());
    else finish(new Error('Nemotron streaming closed'));
  });

  return {
    url,
    send(buf) {
      if (settled || ending || !buf || !buf.byteLength) return;
      if (opened) ws.send(buf);
      else queued.push(buf);
    },
    end() {
      if (settled) return done;
      ending = true;
      if (opened) ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      return done;
    },
    abort() {
      finish(new Error('cancelled'));
    },
  };
}

async function transcribeCloud(wavPath, settings, fetchImpl = fetch) {
  const apiKey = cloudApiKey(settings);
  if (resolveCloudModel(settings) !== 'modulate') {
    return transcribeMistral(wavPath, apiKey, fetchImpl);
  }
  const mode = resolveModulateMode(settings);
  if (mode === 'streaming') {
    throw new Error('Modulate streaming is live and does not take a wav');
  }
  return transcribeModulate(wavPath, apiKey, mode, fetchImpl);
}

module.exports = {
  transcriptionStatus, shouldStartSidecar, transcribeCloud,
  resolveCloudModel, resolveModulateMode, resolveLocalModel,
  shouldStartPythonSidecar, shouldStartNemotron,
  isLiveStreaming, openModulateStream, openNemotronStream, nemotronWsUrl,
};

