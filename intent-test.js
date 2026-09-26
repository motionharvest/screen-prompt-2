const assert = require('assert');
const intent = require('./intent');

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

const keywordType = (value) => (['url', 'command', 'keys', 'alias'].includes(value) ? value : 'url');

const KEYWORDS = [
  { description: 'Searches Google for whatever the user asks about', type: 'url', target: 'https://www.google.com/search?q=%s' },
  { description: 'Changes the current model inside Claude Code to Fable', type: 'keys', target: 'ctrl+m' },
  { description: '', type: 'url', target: 'https://example.com/' },
  { description: 'Half typed', type: 'url', target: '' },
];

function fakeFetch(answers, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status === 200 ? { model: 'jev-1.13.0', answers } : { detail: 'bad key' }),
    };
  };
  impl.calls = calls;
  return impl;
}

async function main() {
  await check('an old keyword becomes a description of saying it', () => {
    const entry = intent.keywordEntry({ word: 'claude fable', type: 'keys', target: 'ctrl+m' }, keywordType);
    assert.strictEqual(entry.description, 'The user says “claude fable”');
    assert.strictEqual(entry.type, 'keys');
    assert.ok(!('word' in entry));
  });

  await check('a description is kept over an old word', () => {
    const entry = intent.keywordEntry({ word: 'x', description: 'Opens mail', type: 'nope', target: 't' }, keywordType);
    assert.strictEqual(entry.description, 'Opens mail');
    assert.strictEqual(entry.type, 'url');
  });

  await check('only keywords with a description and a target are offered', () => {
    const actions = intent.describedActions(KEYWORDS);
    assert.deepStrictEqual(actions.map((a) => a.index), [0, 1]);
  });

  await check('query candidates run from each word to the end, trimmed', () => {
    const candidates = intent.queryCandidates('Google, what is Indiana?');
    assert.deepStrictEqual(candidates.map((c) => c.text),
      ['Google, what is Indiana', 'what is Indiana', 'is Indiana', 'Indiana']);
  });

  await check('the request offers dictation and every action, plus a query question', () => {
    const actions = intent.describedActions(KEYWORDS);
    const body = intent.buildIntentRequest('look up tacos', actions, intent.queryCandidates('look up tacos'));
    assert.strictEqual(body.model, 'jev-latest');
    assert.deepStrictEqual(body.state, { transcript: 'look up tacos' });
    assert.deepStrictEqual(Object.keys(body.questions.action.criteria), ['dictation', 'action 1', 'action 2']);
    assert.deepStrictEqual(Object.keys(body.questions.query.criteria), ['q0', 'q1', 'q2', 'none']);
    assert.deepStrictEqual(body.questions.query.instructions.actions, [KEYWORDS[0].description]);
  });

  await check('no query question when no action takes a query', () => {
    const actions = intent.describedActions([KEYWORDS[1]]);
    const body = intent.buildIntentRequest('switch to fable', actions, intent.queryCandidates('switch to fable'));
    assert.ok(!body.questions.query);
  });

  await check('no key or no keywords sends nothing', async () => {
    const fetchImpl = fakeFetch({});
    assert.strictEqual(await intent.classifyIntent('hi', KEYWORDS, '', fetchImpl), null);
    assert.strictEqual(await intent.classifyIntent('hi', [], 'key', fetchImpl), null);
    assert.strictEqual(fetchImpl.calls.length, 0);
  });

  await check('a confident action runs with the selected query', async () => {
    const fetchImpl = fakeFetch({
      action: { type: 'choice', choice: 'action 1', probabilities: { dictation: 0.1, 'action 1': 0.9, 'action 2': 0 }, confidence: 0.8 },
      query: { type: 'choice', choice: 'q2', probabilities: { q2: 1 }, confidence: 1 },
    });
    const result = await intent.classifyIntent('please search for tacos', KEYWORDS, 'key', fetchImpl);
    assert.strictEqual(result.index, 0);
    assert.strictEqual(result.query, 'for tacos');
    assert.strictEqual(fetchImpl.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.strictEqual(fetchImpl.calls[0].init.headers.Authorization, 'Bearer key');
  });

  await check('an action that takes no query gets none', async () => {
    const fetchImpl = fakeFetch({
      action: { type: 'choice', choice: 'action 2', probabilities: { 'action 2': 0.95, dictation: 0.05 }, confidence: 0.9 },
      query: { type: 'choice', choice: 'q1', probabilities: { q1: 1 }, confidence: 1 },
    });
    const result = await intent.classifyIntent('Please switch to fable', KEYWORDS, 'key', fetchImpl);
    assert.strictEqual(result.index, 1);
    assert.strictEqual(result.query, '');
  });

  await check('dictation and uncertain actions are typed', async () => {
    const dictation = fakeFetch({ action: { type: 'choice', choice: 'dictation', probabilities: { dictation: 0.9 } } });
    assert.strictEqual(await intent.classifyIntent('dear Sam', KEYWORDS, 'key', dictation), null);
    const unsure = fakeFetch({ action: { type: 'choice', choice: 'action 1', probabilities: { 'action 1': 0.5, dictation: 0.5 } } });
    assert.strictEqual(await intent.classifyIntent('google is big', KEYWORDS, 'key', unsure), null);
  });

  await check('an API error is thrown with its reason', async () => {
    await assert.rejects(intent.classifyIntent('hi', KEYWORDS, 'key', fakeFetch({}, 401)), /TypeSafe: bad key/);
  });

  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

main();
