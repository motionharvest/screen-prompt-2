// Tests for the transcription provider — local Parakeet vs cloud models.
// Run with `npm test`.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const transcription = require('./transcription');

let failed = 0;
const check = async (label, fn) => {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
  }
};

async function main() {
  await check('cloud without a key is not ready', () => {
    const status = transcription.transcriptionStatus({ asrProvider: 'cloud', mistralApiKey: '' });
    assert.strictEqual(status.state, 'error');
    assert.strictEqual(status.detail, 'Add a Mistral API key in Processing');
  });

  await check('cloud with a key is ready', () => {
    const status = transcription.transcriptionStatus({ asrProvider: 'cloud', mistralApiKey: 'test-key' });
    assert.strictEqual(status.state, 'ready');
    assert.strictEqual(status.detail, '');
  });

  await check('cloud with a whitespace-only key is not ready', () => {
    const status = transcription.transcriptionStatus({ asrProvider: 'cloud', mistralApiKey: '   ' });
    assert.strictEqual(status.state, 'error');
    assert.strictEqual(status.detail, 'Add a Mistral API key in Processing');
  });

  await check('modulate without a key is not ready', () => {
    const status = transcription.transcriptionStatus({
      asrProvider: 'cloud', cloudModel: 'modulate', modulateApiKey: '',
    });
    assert.strictEqual(status.state, 'error');
    assert.strictEqual(status.detail, 'Add a Modulate API key in Processing');
  });

  await check('modulate with a key is ready', () => {
    const status = transcription.transcriptionStatus({
      asrProvider: 'cloud', cloudModel: 'modulate', modulateApiKey: 'test-key',
    });
    assert.strictEqual(status.state, 'ready');
  });

  await check('a mistral key does not ready modulate', () => {
    const status = transcription.transcriptionStatus({
      asrProvider: 'cloud', cloudModel: 'modulate', mistralApiKey: 'mistral-key',
    });
    assert.strictEqual(status.state, 'error');
    assert.strictEqual(status.detail, 'Add a Modulate API key in Processing');
  });

  await check('a modulate key does not ready mistral', () => {
    const status = transcription.transcriptionStatus({
      asrProvider: 'cloud', cloudModel: 'mistral', modulateApiKey: 'modulate-key',
    });
    assert.strictEqual(status.state, 'error');
    assert.strictEqual(status.detail, 'Add a Mistral API key in Processing');
  });

  await check('an unknown cloud model is mistral', () => {
    assert.strictEqual(transcription.resolveCloudModel({ cloudModel: 'nope' }), 'mistral');
    assert.strictEqual(transcription.resolveCloudModel({}), 'mistral');
    assert.strictEqual(transcription.resolveCloudModel({ cloudModel: 'modulate' }), 'modulate');
  });

  await check('local model defaults to parakeet', () => {
    assert.strictEqual(transcription.resolveLocalModel({}), 'parakeet');
    assert.strictEqual(transcription.resolveLocalModel({ localModel: 'nope' }), 'parakeet');
    assert.strictEqual(transcription.resolveLocalModel({ localModel: 'nemotron' }), 'nemotron');
  });

  await check('modulate mode defaults to fast', () => {
    assert.strictEqual(transcription.resolveModulateMode({}), 'fast');
    assert.strictEqual(transcription.resolveModulateMode({ modulateMode: 'nope' }), 'fast');
    assert.strictEqual(transcription.resolveModulateMode({ modulateMode: 'fast' }), 'fast');
    assert.strictEqual(transcription.resolveModulateMode({ modulateMode: 'multilingual' }), 'multilingual');
    assert.strictEqual(transcription.resolveModulateMode({ modulateMode: 'streaming' }), 'streaming');
  });

  await check('local reports the sidecar state', () => {
    const status = transcription.transcriptionStatus(
      { asrProvider: 'local' },
      { state: 'loading', detail: 'Loading Parakeet v2…' },
    );
    assert.strictEqual(status.state, 'loading');
    assert.strictEqual(status.detail, 'Loading Parakeet v2…');
  });

  await check('a missing provider is local', () => {
    const status = transcription.transcriptionStatus(
      {},
      { state: 'ready', detail: '' },
    );
    assert.strictEqual(status.state, 'ready');
  });

  await check('cloud does not start the sidecar', () => {
    assert.strictEqual(transcription.shouldStartSidecar('cloud'), false);
  });

  await check('local starts the sidecar', () => {
    assert.strictEqual(transcription.shouldStartSidecar('local'), true);
  });

  await check('a missing provider starts the sidecar', () => {
    assert.strictEqual(transcription.shouldStartSidecar(undefined), true);
  });

  await check('parakeet starts the python sidecar, nemotron does not', () => {
    assert.strictEqual(transcription.shouldStartPythonSidecar({ asrProvider: 'local' }), true);
    assert.strictEqual(transcription.shouldStartPythonSidecar({
      asrProvider: 'local', localModel: 'nemotron',
    }), false);
    assert.strictEqual(transcription.shouldStartPythonSidecar({ asrProvider: 'cloud' }), false);
  });

  await check('nemotron starts only as a local model', () => {
    assert.strictEqual(transcription.shouldStartNemotron({
      asrProvider: 'local', localModel: 'nemotron',
    }), true);
    assert.strictEqual(transcription.shouldStartNemotron({ asrProvider: 'local' }), false);
    assert.strictEqual(transcription.shouldStartNemotron({
      asrProvider: 'cloud', localModel: 'nemotron',
    }), false);
  });

  await check('local nemotron is live streaming', () => {
    assert.strictEqual(transcription.isLiveStreaming({
      asrProvider: 'local', localModel: 'nemotron',
    }), true);
    assert.strictEqual(transcription.isLiveStreaming({ asrProvider: 'local' }), false);
  });

  const wav = path.join(os.tmpdir(), 'screen-prompt-2-cloud-test.wav');
  fs.writeFileSync(wav, Buffer.from('RIFF'));

  await check('cloud posts the wav to Mistral and returns the text', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ text: 'hello there' }) };
    };
    const text = await transcription.transcribeCloud(
      wav, { asrProvider: 'cloud', mistralApiKey: 'secret-key' }, fetchImpl,
    );
    assert.strictEqual(text, 'hello there');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.mistral.ai/v1/audio/transcriptions');
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer secret-key');
    assert.ok(calls[0].opts.body instanceof FormData);
    assert.strictEqual(calls[0].opts.body.get('model'), 'voxtral-mini-2602');
    assert.strictEqual(calls[0].opts.body.get('language'), 'en');
    assert.ok(calls[0].opts.body.get('file'));
  });

  await check('cloud joins segment text when the top-level text is missing', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ segments: [{ text: 'hello ' }, { text: 'there' }] }),
    });
    const text = await transcription.transcribeCloud(
      wav, { asrProvider: 'cloud', mistralApiKey: 'secret-key' }, fetchImpl,
    );
    assert.strictEqual(text, 'hello there');
  });

  await check('cloud turns an API error into a thrown message', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
    });
    await assert.rejects(
      () => transcription.transcribeCloud(
        wav, { asrProvider: 'cloud', mistralApiKey: 'bad-key' }, fetchImpl,
      ),
      { message: 'Unauthorized' },
    );
  });

  await check('modulate fast posts to multilingual-vfast', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ text: 'bonjour' }) };
    };
    const text = await transcription.transcribeCloud(wav, {
      asrProvider: 'cloud',
      cloudModel: 'modulate',
      modulateApiKey: 'mod-key',
    }, fetchImpl);
    assert.strictEqual(text, 'bonjour');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://platform.modulate.ai/api/velma-2-stt-batch-multilingual-vfast');
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.strictEqual(calls[0].opts.headers['X-API-Key'], 'mod-key');
    assert.strictEqual(calls[0].opts.headers.Authorization, undefined);
    assert.ok(calls[0].opts.body instanceof FormData);
    assert.ok(calls[0].opts.body.get('upload_file'));
    assert.strictEqual(calls[0].opts.body.get('speaker_diarization'), null);
    assert.strictEqual(calls[0].opts.body.get('language'), null);
  });

  await check('modulate multilingual posts to velma-2-stt-batch', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ text: 'bonjour' }) };
    };
    const text = await transcription.transcribeCloud(wav, {
      asrProvider: 'cloud',
      cloudModel: 'modulate',
      modulateMode: 'multilingual',
      modulateApiKey: 'mod-key',
    }, fetchImpl);
    assert.strictEqual(text, 'bonjour');
    assert.strictEqual(calls[0].url, 'https://platform.modulate.ai/api/velma-2-stt-batch');
    assert.strictEqual(calls[0].opts.body.get('speaker_diarization'), 'false');
  });

  await check('modulate joins utterance text when the top-level text is missing', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ utterances: [{ text: 'Hello.' }, { text: 'Bonjour.' }] }),
    });
    const text = await transcription.transcribeCloud(wav, {
      asrProvider: 'cloud', cloudModel: 'modulate', modulateApiKey: 'mod-key',
    }, fetchImpl);
    assert.strictEqual(text, 'Hello. Bonjour.');
  });

  await check('modulate turns an API error into a thrown message', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Invalid API key.' }),
    });
    await assert.rejects(
      () => transcription.transcribeCloud(wav, {
        asrProvider: 'cloud', cloudModel: 'modulate', modulateApiKey: 'bad-key',
      }, fetchImpl),
      { message: 'Invalid API key.' },
    );
  });

  await check('modulate falls back when detail is not a string', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: [{ msg: 'bad' }] }),
    });
    await assert.rejects(
      () => transcription.transcribeCloud(wav, {
        asrProvider: 'cloud', cloudModel: 'modulate', modulateApiKey: 'key',
      }, fetchImpl),
      { message: 'Modulate returned 422' },
    );
  });

  await check('modulate streaming does not take a wav', async () => {
    await assert.rejects(
      () => transcription.transcribeCloud(wav, {
        asrProvider: 'cloud', cloudModel: 'modulate', modulateMode: 'streaming',
        modulateApiKey: 'mod-key',
      }),
      { message: 'Modulate streaming is live and does not take a wav' },
    );
  });

  await check('live streaming is on only for modulate streaming with a key', () => {
    assert.strictEqual(transcription.isLiveStreaming({
      asrProvider: 'cloud', cloudModel: 'modulate', modulateMode: 'streaming',
      modulateApiKey: 'k',
    }), true);
    assert.strictEqual(transcription.isLiveStreaming({
      asrProvider: 'cloud', cloudModel: 'modulate', modulateMode: 'fast',
      modulateApiKey: 'k',
    }), false);
    assert.strictEqual(transcription.isLiveStreaming({
      asrProvider: 'cloud', cloudModel: 'modulate', modulateMode: 'streaming',
    }), false);
  });

  function fakeSocket(url, { autoOpen = true } = {}) {
    const listeners = {};
    const sent = [];
    const ws = {
      url,
      sent,
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      send(data) { sent.push(data); },
      close() { ws.closed = true; },
      emit(type, event) { for (const fn of listeners[type] || []) fn(event); },
    };
    if (autoOpen) queueMicrotask(() => ws.emit('open'));
    return ws;
  }

  const streamingSettings = {
    asrProvider: 'cloud',
    cloudModel: 'modulate',
    modulateMode: 'streaming',
    modulateApiKey: 'mod-key',
  };

  await check('live stream queues pcm until the socket opens, then ends with a text frame', async () => {
    let ws;
    const WebSocketImpl = function WebSocketImpl(url) {
      ws = fakeSocket(url, { autoOpen: false });
      return ws;
    };
    const stream = transcription.openModulateStream(streamingSettings, WebSocketImpl);
    assert.ok(stream.url.startsWith('wss://platform.modulate.ai/api/velma-2-stt-streaming-multilingual-vfast?'));
    assert.ok(stream.url.includes('api_key=mod-key'));
    assert.ok(stream.url.includes('audio_format=s16le'));
    assert.ok(stream.url.includes('sample_rate=16000'));
    assert.ok(stream.url.includes('num_channels=1'));
    assert.ok(stream.url.includes('endpointing=true'));
    const a = Buffer.from([1, 0]);
    const b = Buffer.from([2, 0]);
    stream.send(a);
    stream.send(b);
    assert.strictEqual(ws.sent.length, 0);
    ws.emit('open');
    assert.deepStrictEqual(ws.sent, [a, b]);
    const pending = stream.end();
    assert.strictEqual(ws.sent[2], '');
    ws.emit('message', { data: JSON.stringify({ type: 'utterance', utterance: { text: 'Hello.' } }) });
    ws.emit('message', { data: JSON.stringify({ type: 'utterance', utterance: { text: 'Bonjour.' } }) });
    ws.emit('message', { data: JSON.stringify({ type: 'done', duration_ms: 1200 }) });
    assert.strictEqual(await pending, 'Hello. Bonjour.');
    assert.strictEqual(ws.closed, true);
  });

  await check('live stream turns an error message into a thrown message', async () => {
    let ws;
    const WebSocketImpl = function WebSocketImpl(url) {
      ws = fakeSocket(url);
      return ws;
    };
    const stream = transcription.openModulateStream(streamingSettings, WebSocketImpl);
    const pending = stream.end();
    await Promise.resolve();
    ws.emit('message', { data: JSON.stringify({ type: 'error', error: 'Invalid API key.' }) });
    await assert.rejects(() => pending, { message: 'Invalid API key.' });
  });

  await check('live stream maps a close code when there is no error frame', async () => {
    let ws;
    const WebSocketImpl = function WebSocketImpl(url) {
      ws = fakeSocket(url);
      return ws;
    };
    const stream = transcription.openModulateStream(streamingSettings, WebSocketImpl);
    const pending = stream.end();
    await Promise.resolve();
    ws.emit('close', { code: 4001 });
    await assert.rejects(() => pending, { message: 'Invalid API key.' });
  });

  await check('live stream abort rejects and does not send end-of-audio', async () => {
    let ws;
    const WebSocketImpl = function WebSocketImpl(url) {
      ws = fakeSocket(url);
      return ws;
    };
    const stream = transcription.openModulateStream(streamingSettings, WebSocketImpl);
    await Promise.resolve();
    stream.send(Buffer.from([1, 0]));
    stream.abort();
    await assert.rejects(() => stream.end(), { message: 'cancelled' });
    assert.ok(!ws.sent.includes(''));
  });

  await check('nemotron stream sends session.update then pcm then commit', async () => {
    let ws;
    const WebSocketImpl = function WebSocketImpl(url) {
      ws = fakeSocket(url, { autoOpen: false });
      return ws;
    };
    const stream = transcription.openNemotronStream(18765, WebSocketImpl);
    assert.strictEqual(stream.url, 'ws://127.0.0.1:18765/v1/audio/transcriptions/realtime');
    const pcm = Buffer.from([1, 0, 2, 0]);
    stream.send(pcm);
    ws.emit('open');
    assert.strictEqual(typeof ws.sent[0], 'string');
    const session = JSON.parse(ws.sent[0]);
    assert.strictEqual(session.type, 'session.update');
    assert.strictEqual(session.session.sample_rate, 16000);
    assert.strictEqual(session.session.language, 'auto');
    assert.deepStrictEqual(ws.sent[1], pcm);
    const pending = stream.end();
    const commit = JSON.parse(ws.sent[2]);
    assert.strictEqual(commit.type, 'input_audio_buffer.commit');
    ws.emit('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'hello there',
      }),
    });
    ws.emit('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed' }) });
    assert.strictEqual(await pending, 'hello there');
  });

  await check('nemotron stream uses the last partial when nothing finalized', async () => {
    let ws;
    const WebSocketImpl = function WebSocketImpl(url) {
      ws = fakeSocket(url);
      return ws;
    };
    const stream = transcription.openNemotronStream(18765, WebSocketImpl);
    await Promise.resolve();
    const pending = stream.end();
    ws.emit('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'partial text',
      }),
    });
    ws.emit('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed' }) });
    assert.strictEqual(await pending, 'partial text');
  });

  try { fs.unlinkSync(wav); } catch { /* leftover of a failed run */ }

  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

main();
