const fs = require('fs');
const path = require('path');

const CLOUD_URL = 'https://api.mistral.ai/v1/audio/transcriptions';
const CLOUD_MODEL = 'voxtral-mini-2602';

function transcriptionStatus(settings, sidecar) {
  if (settings && settings.asrProvider === 'cloud') {
    const key = String(settings.mistralApiKey || '').trim();
    if (key) return { state: 'ready', detail: '' };
    return { state: 'error', detail: 'Add a Mistral API key in Processing' };
  }
  return {
    state: sidecar && sidecar.state ? sidecar.state : 'stopped',
    detail: sidecar && sidecar.detail ? sidecar.detail : '',
  };
}

function shouldStartSidecar(provider) {
  return provider !== 'cloud';
}

async function transcribeCloud(wavPath, apiKey, fetchImpl = fetch) {
  const buf = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('model', CLOUD_MODEL);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(wavPath));
  const res = await fetchImpl(CLOUD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    throw new Error(body.message || body.detail || (body.error && body.error.message)
      || `Mistral returned ${res.status}`);
  }
  return body.text || '';
}

module.exports = { transcriptionStatus, shouldStartSidecar, transcribeCloud };
