// Tests for the transcription provider — local Parakeet vs cloud Voxtral.
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

  const wav = path.join(os.tmpdir(), 'screen-prompt-2-cloud-test.wav');
  fs.writeFileSync(wav, Buffer.from('RIFF'));

  await check('cloud posts the wav to Mistral and returns the text', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ text: 'hello there' }) };
    };
    const text = await transcription.transcribeCloud(wav, 'secret-key', fetchImpl);
    assert.strictEqual(text, 'hello there');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.mistral.ai/v1/audio/transcriptions');
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer secret-key');
    assert.ok(calls[0].opts.body instanceof FormData);
    assert.strictEqual(calls[0].opts.body.get('model'), 'voxtral-mini-2602');
    assert.ok(calls[0].opts.body.get('file'));
  });

  await check('cloud turns an API error into a thrown message', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
    });
    await assert.rejects(
      () => transcription.transcribeCloud(wav, 'bad-key', fetchImpl),
      { message: 'Unauthorized' },
    );
  });

  try { fs.unlinkSync(wav); } catch { /* leftover of a failed run */ }

  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

main();
