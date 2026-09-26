const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 6000;
const ACTION_THRESHOLD = 0.6;
const MAX_QUERY_WORDS = 40;
const DICTATION = 'dictation';
const NO_QUERY = 'none';
const DESCRIPTION_MAX = 500;

function typesafeApiKey(settings) {
  return String(settings && settings.typesafeApiKey || '').trim();
}

/**
 * Normalizes one saved keyword. An entry from before descriptions existed has
 * only a spoken `word`, which becomes a description of saying that word.
 */
function keywordEntry(entry, keywordType) {
  const raw = entry || {};
  const word = String(raw.word || '').trim();
  const description = String(raw.description || '').trim()
    || (word ? `The user says “${word}”` : '');
  return {
    description: description.slice(0, DESCRIPTION_MAX),
    type: keywordType(raw.type),
    target: String(raw.target || '').trim(),
  };
}

function takesQuery(entry) {
  if (entry.type === 'url') return true;
  if (entry.type === 'command' || entry.type === 'alias') return entry.target.includes('%s');
  return false;
}

function describedActions(keywords) {
  const out = [];
  (keywords || []).forEach((entry, index) => {
    const description = String(entry && entry.description || '').trim();
    const target = String(entry && entry.target || '').trim();
    if (description && target) out.push({ ...entry, description, target, index });
  });
  return out;
}

function trimQuery(text) {
  return text.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[.,!?;:…\s]+$/u, '').trim();
}

function queryCandidates(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null && out.length < MAX_QUERY_WORDS) {
    const rest = trimQuery(text.slice(m.index));
    if (rest && !out.some((c) => c.text === rest)) out.push({ id: `q${out.length}`, text: rest });
  }
  return out;
}

function actionKey(n) {
  return `action ${n + 1}`;
}

function buildIntentRequest(text, actions, candidates) {
  const criteria = {
    [DICTATION]: 'The user is dictating text to be typed into the application they are working in. '
      + 'The words are content to write, not a request for the computer to do something.',
  };
  actions.forEach((action, n) => { criteria[actionKey(n)] = action.description; });
  const questions = {
    action: {
      type: 'choice',
      instructions: 'The user spoke `transcript` into a dictation app. Did they ask the computer '
        + 'to perform one of the actions, or are they dictating text to be typed?',
      criteria,
    },
  };
  const queryActions = actions.filter(takesQuery);
  if (queryActions.length && candidates.length) {
    const options = {};
    for (const c of candidates) options[c.id] = `“${c.text}”`;
    options[NO_QUERY] = 'The transcript names no subject for the action to act on.';
    questions.query = {
      type: 'choice',
      instructions: {
        actions: queryActions.map((action) => action.description),
        question: 'Suppose `transcript` asks the computer to perform one of `actions`. The words '
          + 'that name what the action should act on, such as a search, a name, or text to insert, '
          + 'run from some word to the end of `transcript`. Which option is exactly those words, '
          + 'without the part that only asks for the action?',
      },
      criteria: options,
    };
  }
  return { state: { transcript: text }, model: JEV_MODEL, questions };
}

/**
 * Turns a Jev response into the action to run and its query, or null when the
 * transcript is dictation or no action is probable enough to act on.
 */
function readIntent(body, actions, candidates) {
  const answer = body && body.answers && body.answers.action;
  if (!answer || !answer.choice || answer.choice === DICTATION) return null;
  const n = actions.findIndex((_, i) => actionKey(i) === answer.choice);
  if (n < 0) return null;
  const probability = Number(answer.probabilities && answer.probabilities[answer.choice]);
  if (!(probability >= ACTION_THRESHOLD)) return null;
  const action = actions[n];
  let query = '';
  const picked = body.answers.query && body.answers.query.choice;
  if (takesQuery(action) && picked && picked !== NO_QUERY) {
    const candidate = candidates.find((c) => c.id === picked);
    if (candidate) query = candidate.text;
  }
  return { ...action, query, probability };
}

function errorMessage(body, status) {
  const detail = body && (body.message || body.detail || (body.error && body.error.message));
  if (typeof detail === 'string' && detail) return `TypeSafe: ${detail}`;
  if (status === 401) return 'TypeSafe: invalid API key.';
  if (status === 429 || status === 529) return 'TypeSafe is busy; try again shortly.';
  return `TypeSafe returned ${status}`;
}

/**
 * Asks Jev whether `text` requests one of the described keywords. Resolves to
 * the keyword with its `query`, or null for dictation.
 */
async function classifyIntent(text, keywords, apiKey, fetchImpl = fetch) {
  const actions = describedActions(keywords);
  if (!apiKey || !actions.length) return null;
  const candidates = queryCandidates(text);
  const res = await fetchImpl(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildIntentRequest(text, actions, candidates)),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) throw new Error(errorMessage(body, res.status));
  return readIntent(body, actions, candidates);
}

module.exports = {
  ACTION_THRESHOLD, typesafeApiKey, keywordEntry, takesQuery, describedActions,
  queryCandidates, buildIntentRequest, readIntent, classifyIntent,
};
