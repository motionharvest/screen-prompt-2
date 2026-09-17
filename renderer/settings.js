const $ = (id) => document.getElementById(id);

let capturing = false;
let currentPretty = '';

// ------------------------------------------------------------------- tabs --

// The tab bar is one control, not four: exactly one tab is in the page's tab
// order at a time and the arrow keys move between them, which is how a
// segmented control is expected to behave and what the roles above it promise.
// The window is hidden rather than closed, so whichever tab you were on is
// still there the next time it opens.

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(chosen) {
  for (const tab of tabs) {
    const on = tab === chosen;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !on;
  }
  // A short panel after a long one would otherwise open scrolled halfway down.
  document.querySelector('.content').scrollTo(0, 0);
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const step = {
      ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1,
      Home: -index, End: tabs.length - 1 - index,
    }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
  });
});

const MB = 1024 * 1024;

function showProgress(p) {
  const wrap = $('progress-wrap');
  if (!p || !p.total) { wrap.style.display = 'none'; return null; }
  if (p.finished) { wrap.style.display = 'none'; return 'Preparing model…'; }
  wrap.style.display = 'block';
  const pct = Math.min(100, (p.done / p.total) * 100);
  $('progress-fill').style.width = `${pct.toFixed(1)}%`;
  $('progress-pct').textContent =
    `${pct.toFixed(0)}% — ${(p.done / MB).toFixed(0)} / ${(p.total / MB).toFixed(0)} MB`;
  $('progress-speed').textContent = p.speed > 0 ? `${(p.speed / MB).toFixed(1)} MB/s` : '';
  return `Downloading ${ENGINE_NAME[selectedEngine()]}…`;
}

function engineStatus({ modelState, modelDetail, modelProgress }) {
  const downloadText = modelState === 'loading' ? showProgress(modelProgress) : showProgress(null);
  if (modelState === 'ready') {
    return { cls: 'ready', text: `Ready — press ${currentPretty} and talk` };
  }
  if (modelState === 'error') {
    return { cls: 'error', text: modelDetail || 'Transcriber failed to start' };
  }
  return { cls: '', text: downloadText || modelDetail || 'Loading model…' };
}

function showStatus(state) {
  if (state.pretty) {
    currentPretty = state.pretty;
    if (!capturing) $('shortcut-display').textContent = state.pretty;
  }
  const engine = engineStatus(state);
  $('engine-dot').className = `dot ${engine.cls}`;
  $('engine-text').textContent = engine.text.replace(/ in Processing$/, ' below');

  const dot = $('status-dot');
  const text = $('status-text');
  text.classList.toggle('quiet', engine.cls === 'ready');
  if (state.appState === 'recording') {
    dot.className = 'dot recording'; text.textContent = 'Recording…';
  } else if (state.appState === 'processing') {
    dot.className = 'dot recording'; text.textContent = 'Transcribing…';
  } else {
    dot.className = `dot ${engine.cls}`; text.textContent = engine.text;
  }
}

// The slider is phrased as "reduce by", which reads the way people think about
// it; the setting stores the fraction other apps are left playing at.
const reductionToLevel = (pct) => (100 - pct) / 100;
const levelToReduction = (level) => Math.round((1 - level) * 100);

function showDuck(enabled, reduction) {
  $('duck-level').value = reduction;
  $('duck-value').textContent = `${reduction}%`;
  $('duck-level').disabled = !enabled;
  $('duck-row').classList.toggle('off', !enabled);
}

// ---------------------------------------------------------------- keywords --

let keywords = [];

// The command example is replaced at init with one that exists on this OS —
// a Windows path shown as the hint on a Mac is worse than no hint.
const PLACEHOLDER = {
  url: 'https://www.google.com/search?q=%s',
  command: 'notepad.exe %s',
};
let launchAppTarget = '';

function saveKeywords() {
  window.api.setSettings({ keywords });
}

function renderKeywords() {
  const list = $('keyword-list');
  list.textContent = '';
  $('keyword-empty').style.display = keywords.length ? 'none' : 'block';

  keywords.forEach((keyword, index) => {
    const row = document.createElement('div');
    row.className = 'kw';
    row.innerHTML = `
      <input type="text" class="kw-word" placeholder="Google" spellcheck="false">
      <select class="kw-type">
        <option value="url">Open a URL</option>
        <option value="command">Run a command</option>
      </select>
      <input type="text" class="kw-target" spellcheck="false">
      <button class="kw-del" title="Remove">&times;</button>
    `;
    // Values are assigned as properties rather than interpolated into the
    // markup above, so a keyword containing quotes cannot break out of it.
    const word = row.querySelector('.kw-word');
    const type = row.querySelector('.kw-type');
    const target = row.querySelector('.kw-target');
    word.value = keyword.word || '';
    type.value = keyword.type === 'command' ? 'command' : 'url';
    target.value = keyword.target || '';
    target.placeholder = PLACEHOLDER[type.value];

    // 'change' rather than 'input': it fires on blur, so a settings write does
    // not happen on every keystroke.
    word.addEventListener('change', () => { keywords[index].word = word.value.trim(); saveKeywords(); });
    target.addEventListener('change', () => { keywords[index].target = target.value.trim(); saveKeywords(); });
    type.addEventListener('change', () => {
      keywords[index].type = type.value;
      target.placeholder = PLACEHOLDER[type.value];
      saveKeywords();
    });
    row.querySelector('.kw-del').addEventListener('click', () => {
      keywords.splice(index, 1);
      renderKeywords();
      saveKeywords();
    });
    list.appendChild(row);
  });
  $('launch-add').disabled = !launchAppTarget
    || keywords.some((k) => k.type === 'command' && k.target === launchAppTarget);
}

$('keyword-add').addEventListener('click', () => {
  keywords.push({ word: '', type: 'url', target: '' });
  renderKeywords();
  $('keyword-list').lastElementChild.querySelector('.kw-word').focus();
});

$('launch-add').addEventListener('click', () => {
  if ($('launch-add').disabled) return;
  keywords.push({ word: 'Launch', type: 'command', target: launchAppTarget });
  renderKeywords();
  saveKeywords();
  $('keyword-list').lastElementChild.querySelector('.kw-word').focus();
});

// -------------------------------------------------------------- dictionary --

let dictionary = [];

function saveDictionary() {
  window.api.setSettings({ dictionary });
}

function renderDictionary() {
  const list = $('dict-list');
  list.textContent = '';
  $('dict-empty').style.display = dictionary.length ? 'none' : 'block';

  dictionary.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'dict';
    row.innerHTML = `
      <input type="text" class="dict-from" placeholder="clawed" spellcheck="false">
      <span class="arrow">&rarr;</span>
      <input type="text" class="dict-to" placeholder="Claude" spellcheck="false">
      <button class="dict-del" title="Remove">&times;</button>
    `;
    // Assigned as properties rather than interpolated into the markup above, so
    // an entry containing quotes cannot break out of it.
    const from = row.querySelector('.dict-from');
    const to = row.querySelector('.dict-to');
    from.value = entry.from || '';
    to.value = entry.to || '';

    // 'change' rather than 'input', so a settings write does not happen on
    // every keystroke — the same as the keyword rows above.
    from.addEventListener('change', () => { dictionary[index].from = from.value.trim(); saveDictionary(); });
    to.addEventListener('change', () => { dictionary[index].to = to.value.trim(); saveDictionary(); });
    row.querySelector('.dict-del').addEventListener('click', () => {
      dictionary.splice(index, 1);
      renderDictionary();
      saveDictionary();
    });
    list.appendChild(row);
  });
}

$('dict-add').addEventListener('click', () => {
  dictionary.push({ from: '', to: '' });
  renderDictionary();
  $('dict-list').lastElementChild.querySelector('.dict-from').focus();
});

// ---------------------------------------------------------------- platform --

// Everything the settings page has to say differently on each OS is driven from
// the one object main sends, so this file never tests process.platform itself.
function applyPlatform(info) {
  if (!info) return;

  $('startup-label').textContent = info.autostartLabel;
  PLACEHOLDER.command = info.commandExample;
  $('cmd-example').textContent = info.commandExample;
  launchAppTarget = info.launchAppTarget || '';

  const duckNote = $('duck-note');
  if (info.ducking.note) {
    duckNote.textContent = info.ducking.note;
    duckNote.style.display = 'block';
  }
  if (!info.ducking.supported) {
    $('duck').disabled = true;
    $('duck-level').disabled = true;
  }

  const box = $('platform-warnings');
  if (!info.warnings.length) return;
  box.style.display = 'block';
  for (const text of info.warnings) {
    const card = document.createElement('div');
    card.className = 'warn';
    // textContent, not innerHTML: these strings are assembled in main and this
    // keeps that a one-way data path rather than a markup one.
    card.textContent = text;
    box.appendChild(card);
  }
  if (info.canRequestPermission && !info.paste) {
    const button = document.createElement('button');
    button.textContent = 'Grant permission…';
    button.addEventListener('click', () => window.api.requestPermission());
    box.lastElementChild.appendChild(button);
  }
}

// Louder than a platform warning and shown above them: this one says something
// went missing, and it is the only notice you get before the next flick of a
// switch overwrites the file it is talking about.
function showDataWarning(text) {
  if (!text) return;
  const box = $('platform-warnings');
  const card = document.createElement('div');
  card.className = 'warn';
  card.textContent = text;
  box.prepend(card);
  box.style.display = 'block';
}

async function init() {
  const state = await window.api.getState();
  showStatus(state);
  applyPlatform(state.platform);
  showDataWarning(state.dataWarning);
  document.querySelector(`input[name="mode"][value="${state.settings.mode}"]`).checked = true;
  document.querySelector(`input[name="output"][value="${state.settings.output}"]`).checked = true;
  document.querySelector(`input[name="theme"][value="${state.settings.theme}"]`).checked = true;
  applyTheme(state.settings.theme);
  $('version').textContent = `Version ${new URLSearchParams(location.search).get('v') || ''}`.trim();
  $('sounds').checked = state.settings.sounds;
  $('startup').checked = state.settings.launchAtStartup;
  $('tidy').checked = state.settings.tidy;
  $('skip-chunking').checked = state.settings.skipChunking;
  $('keep-mic-warm').checked = state.settings.keepMicWarm;
  $('restore-clipboard').checked = state.settings.restoreClipboard;
  $('mistral-key').value = state.settings.mistralApiKey || '';
  $('modulate-key').value = state.settings.modulateApiKey || '';
  showEngine(engineOf(state.settings), state.settings.modulateMode);
  $('overlay-follow').checked = state.settings.overlayFollow;
  $('overlay-always').checked = state.settings.overlayAlways;
  showRestoreClipboard(state.settings.output);
  keywords = (state.settings.keywords || []).map((k) => ({ ...k }));
  renderKeywords();
  dictionary = (state.settings.dictionary || []).map((d) => ({ ...d }));
  renderDictionary();
  $('duck').checked = state.settings.duck;
  showDuck(state.settings.duck, levelToReduction(state.settings.duckLevel));
  history = state.history || [];
  renderHistory();
  renderStats(state.stats);
}

for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener('change', () => window.api.setSettings({ mode: input.value }));
}
// Restoring the clipboard is a paste-mode idea: copy-only leaves the text
// there on purpose, and type mode never touches it at all.
function showRestoreClipboard(output) {
  const on = output === 'paste';
  $('restore-clipboard').disabled = !on;
  $('restore-clipboard-row').classList.toggle('off', !on);
}

function resolveMode(modulateMode) {
  if (modulateMode === 'streaming' || modulateMode === 'multilingual') return modulateMode;
  return 'fast';
}

const ENGINE_NAME = {
  parakeet: 'Parakeet v2', nemotron: 'Nemotron 3.5', mistral: 'Mistral', modulate: 'Modulate',
};
const ENGINE_SETTINGS = {
  parakeet: { asrProvider: 'local', localModel: 'parakeet' },
  nemotron: { asrProvider: 'local', localModel: 'nemotron' },
  mistral: { asrProvider: 'cloud', cloudModel: 'mistral' },
  modulate: { asrProvider: 'cloud', cloudModel: 'modulate' },
};

function engineOf(settings) {
  if (settings.asrProvider === 'cloud') {
    return settings.cloudModel === 'modulate' ? 'modulate' : 'mistral';
  }
  return settings.localModel === 'nemotron' ? 'nemotron' : 'parakeet';
}

function selectedEngine() {
  const picked = document.querySelector('input[name="engine"]:checked');
  return picked && ENGINE_SETTINGS[picked.value] ? picked.value : 'parakeet';
}

function selectedModulateMode() {
  const picked = document.querySelector('input[name="modulate-mode"]:checked');
  return resolveMode(picked && picked.value);
}

const MODE_LABEL = { fast: 'fast', streaming: 'streaming', multilingual: 'full' };

function showEngine(engine, modulateMode) {
  const mode = resolveMode(modulateMode);
  document.querySelector(`input[name="engine"][value="${engine}"]`).checked = true;
  document.querySelector(`input[name="modulate-mode"][value="${mode}"]`).checked = true;
  for (const name of Object.keys(ENGINE_SETTINGS)) {
    $(`engine-${name}`).hidden = name !== engine;
  }
  $('modulate-tag').textContent = MODE_LABEL[mode];
  const where = ENGINE_SETTINGS[engine].asrProvider === 'cloud' ? 'in the cloud' : 'on this device';
  const detail = engine === 'modulate' ? ` ${MODE_LABEL[mode]}` : '';
  $('tagline').textContent = `${ENGINE_NAME[engine]}${detail} ${where}`;
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === 'synthwave' ? 'synthwave' : 'default';
}

for (const input of document.querySelectorAll('input[name="output"]')) {
  input.addEventListener('change', () => {
    showRestoreClipboard(input.value);
    window.api.setSettings({ output: input.value });
  });
}
for (const input of document.querySelectorAll('input[name="theme"]')) {
  input.addEventListener('change', () => {
    applyTheme(input.value);
    window.api.setSettings({ theme: input.value });
  });
}
for (const input of document.querySelectorAll('input[name="engine"]')) {
  input.addEventListener('change', () => {
    showEngine(input.value, selectedModulateMode());
    window.api.setSettings(ENGINE_SETTINGS[input.value]);
  });
}
for (const input of document.querySelectorAll('input[name="modulate-mode"]')) {
  input.addEventListener('change', () => {
    showEngine('modulate', input.value);
    window.api.setSettings({ modulateMode: input.value });
  });
}
$('mistral-key').addEventListener('change', (e) => {
  window.api.setSettings({ mistralApiKey: e.target.value });
});
$('modulate-key').addEventListener('change', (e) => {
  window.api.setSettings({ modulateApiKey: e.target.value });
});
$('tidy').addEventListener('change', (e) => window.api.setSettings({ tidy: e.target.checked }));
$('skip-chunking').addEventListener('change', (e) => window.api.setSettings({ skipChunking: e.target.checked }));
$('keep-mic-warm').addEventListener('change', (e) => window.api.setSettings({ keepMicWarm: e.target.checked }));
$('restore-clipboard').addEventListener('change', (e) => window.api.setSettings({ restoreClipboard: e.target.checked }));
$('duck').addEventListener('change', (e) => {
  showDuck(e.target.checked, Number($('duck-level').value));
  window.api.setSettings({ duck: e.target.checked });
});
// 'input' for the live readout while dragging, 'change' to persist once the
// thumb is dropped — otherwise a drag would write settings.json on every step.
$('duck-level').addEventListener('input', (e) => {
  $('duck-value').textContent = `${e.target.value}%`;
});
$('duck-level').addEventListener('change', (e) => {
  window.api.setSettings({ duckLevel: reductionToLevel(Number(e.target.value)) });
});
$('sounds').addEventListener('change', (e) => window.api.setSettings({ sounds: e.target.checked }));
$('overlay-follow').addEventListener('change', (e) => window.api.setSettings({ overlayFollow: e.target.checked }));
$('overlay-always').addEventListener('change', (e) => window.api.setSettings({ overlayAlways: e.target.checked }));
$('startup').addEventListener('change', (e) => window.api.setSettings({ launchAtStartup: e.target.checked }));

$('change-btn').addEventListener('click', () => {
  const err = $('capture-error');
  err.style.display = 'none';
  if (capturing) {
    capturing = false;
    window.api.captureCancel();
    $('change-btn').textContent = 'Change';
    $('shortcut-display').classList.remove('capturing');
    $('shortcut-display').textContent = currentPretty;
    return;
  }
  capturing = true;
  window.api.captureStart();
  $('change-btn').textContent = 'Cancel';
  $('shortcut-display').classList.add('capturing');
  $('shortcut-display').textContent = 'Press a shortcut…';
});

window.api.onCaptureEvent((ev) => {
  const display = $('shortcut-display');
  const err = $('capture-error');
  switch (ev.type) {
    case 'held':
      display.textContent = ev.display;
      break;
    case 'error':
      err.textContent = ev.message;
      err.style.display = 'block';
      break;
    case 'done':
      capturing = false;
      currentPretty = ev.pretty;
      display.classList.remove('capturing');
      display.textContent = ev.pretty;
      $('change-btn').textContent = 'Change';
      err.style.display = 'none';
      break;
    case 'cancelled':
      capturing = false;
      display.classList.remove('capturing');
      display.textContent = currentPretty;
      $('change-btn').textContent = 'Change';
      break;
  }
});

// ---------------------------------------------------------------- history --

// Main owns the list — it is the one that writes the file and enforces the
// thirty days — so this only ever renders what it is given and prepends what
// arrives. The window is hidden rather than closed, so an open History tab
// grows a row as each dictation finishes.

let history = [];

// A time is only useful here if you can place it without doing arithmetic, so
// the recent past is named rather than dated and only the older entries get a
// calendar date.
function whenLabel(at) {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(when)) / 86400000);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${when.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  return `${when.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

const copyTimers = new WeakMap();

function historyRow(entry) {
  const row = document.createElement('button');
  row.className = 'hist';
  row.title = entry.text;          // the whole thing, for the rows that clamp
  row.innerHTML = `
    <div class="hist-when"><span class="when"></span><span class="hist-copied">copied</span></div>
    <div class="hist-text"></div>
  `;
  // textContent rather than markup: a transcript is arbitrary text and has no
  // business being parsed as HTML.
  row.querySelector('.when').textContent = whenLabel(entry.at);
  row.querySelector('.hist-text').textContent = entry.text;

  row.addEventListener('click', () => {
    // Marked copied before the clipboard write rather than after it: the write
    // is a round trip to main, and a click should answer in the same frame.
    row.classList.add('copied');
    clearTimeout(copyTimers.get(row));
    copyTimers.set(row, setTimeout(() => row.classList.remove('copied'), 1300));
    window.api.copyText(entry.text);
  });
  return row;
}

function renderHistory() {
  const list = $('history-list');
  list.textContent = '';
  $('history-empty').style.display = history.length ? 'none' : 'block';
  for (const entry of history) list.appendChild(historyRow(entry));
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

function renderStats(snap) {
  const stats = snap || {};
  $('stat-words').textContent = fmtNum(stats.words);
  $('stat-fixes').textContent = fmtNum(stats.fixes);
  $('stat-wpm').textContent = stats.wpm == null ? '—' : fmtNum(stats.wpm);
  const streak = stats.streak || 0;
  $('stat-streak').textContent = fmtNum(streak);
  $('streak-caption').textContent = streak
    ? (streak === 1 ? 'You have dictated today. Keep it going tomorrow.' : `${fmtNum(streak)} days in a row.`)
    : 'Dictate on consecutive days to build a streak.';

  const months = $('streak-months');
  const weeksEl = $('streak-weeks');
  months.textContent = '';
  weeksEl.textContent = '';
  const columns = `repeat(${(stats.weeks || []).length || 53}, minmax(0, 1fr))`;
  months.style.gridTemplateColumns = columns;
  weeksEl.style.gridTemplateColumns = columns;
  for (const week of stats.weeks || []) {
    const label = document.createElement('span');
    label.textContent = week.label || '';
    months.appendChild(label);

    const col = document.createElement('div');
    col.className = 'streak-week';
    for (const cell of week.days) {
      const sq = document.createElement('span');
      sq.className = `streak-cell l${cell.level}`;
      if (cell.today) sq.classList.add('today');
      if (cell.future) sq.classList.add('future');
      const when = new Date(cell.date + 'T00:00:00');
      const dateLabel = when.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
      const wordsLabel = cell.words ? `${fmtNum(cell.words)} words` : 'no dictation';
      sq.title = `${dateLabel} — ${wordsLabel}`;
      sq.setAttribute('aria-label', `${dateLabel}, ${wordsLabel}`);
      col.appendChild(sq);
    }
    weeksEl.appendChild(col);
  }
}

// Two presses rather than a confirm dialog: a modal would block the whole app,
// and this says the same thing without one. The offer lapses on its own, so a
// stray first click cannot leave the button armed.
let clearTimer = null;
$('history-clear').addEventListener('click', async () => {
  const button = $('history-clear');
  if (!button.classList.contains('confirming')) {
    if (!history.length) return;
    button.classList.add('confirming');
    button.textContent = 'Delete everything?';
    clearTimer = setTimeout(() => {
      button.classList.remove('confirming');
      button.textContent = 'Clear history';
    }, 4000);
    return;
  }
  clearTimeout(clearTimer);
  button.classList.remove('confirming');
  button.textContent = 'Clear history';
  const cleared = await window.api.clearHistory();
  history = [];
  renderHistory();
  renderStats(cleared);
});

// A setting the app changed on its own — so far only the follow switch, which a
// drag of the pill turns off.
window.api.onSettingsChanged((partial) => {
  if (partial.overlayFollow !== undefined) $('overlay-follow').checked = partial.overlayFollow;
});

window.api.onState(showStatus);
window.api.onTranscription((payload) => {
  const entry = payload && payload.entry ? payload.entry : payload;
  history.unshift(entry);
  $('history-empty').style.display = 'none';
  $('history-list').prepend(historyRow(entry));
  if (payload && payload.stats) renderStats(payload.stats);
});

init();
