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
  window.scrollTo(0, 0);
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: tabs.length - 1 - index }[e.key];
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
  return `Downloading Parakeet v2…`;
}

function showStatus({ appState, modelState, modelDetail, modelProgress, pretty }) {
  if (pretty) {
    currentPretty = pretty;
    if (!capturing) $('shortcut-display').textContent = pretty;
  }
  const dot = $('status-dot');
  const text = $('status-text');
  const downloadText = modelState === 'loading' ? showProgress(modelProgress) : showProgress(null);
  if (appState === 'recording') {
    dot.className = 'recording'; text.textContent = 'Recording…';
  } else if (appState === 'processing') {
    dot.className = 'recording'; text.textContent = 'Transcribing…';
  } else if (modelState === 'ready') {
    dot.className = 'ready'; text.textContent = `Ready — press ${currentPretty} and talk`;
  } else if (modelState === 'error') {
    dot.className = 'error'; text.textContent = modelDetail || 'Transcriber failed to start';
  } else {
    dot.className = ''; text.textContent = downloadText || modelDetail || 'Loading model…';
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
      <div class="kw-top">
        <input type="text" class="kw-word" placeholder="Google" spellcheck="false">
        <select class="kw-type">
          <option value="url">Open a URL</option>
          <option value="command">Run a command</option>
        </select>
        <button class="kw-del" title="Remove">&times;</button>
      </div>
      <input type="text" class="kw-target" spellcheck="false">
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
}

$('keyword-add').addEventListener('click', () => {
  keywords.push({ word: '', type: 'url', target: '' });
  renderKeywords();
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
  $('sounds').checked = state.settings.sounds;
  $('startup').checked = state.settings.launchAtStartup;
  $('tidy').checked = state.settings.tidy;
  $('skip-chunking').checked = state.settings.skipChunking;
  $('keep-mic-warm').checked = state.settings.keepMicWarm;
  $('restore-clipboard').checked = state.settings.restoreClipboard;
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

for (const input of document.querySelectorAll('input[name="output"]')) {
  input.addEventListener('change', () => {
    showRestoreClipboard(input.value);
    window.api.setSettings({ output: input.value });
  });
}
for (const input of document.querySelectorAll('input[name="theme"]')) {
  input.addEventListener('change', () => window.api.setSettings({ theme: input.value }));
}
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
  await window.api.clearHistory();
  history = [];
  renderHistory();
});

// A setting the app changed on its own — so far only the follow switch, which a
// drag of the pill turns off.
window.api.onSettingsChanged((partial) => {
  if (partial.overlayFollow !== undefined) $('overlay-follow').checked = partial.overlayFollow;
});

window.api.onState(showStatus);
window.api.onTranscription((entry) => {
  history.unshift(entry);
  $('history-empty').style.display = 'none';
  $('history-list').prepend(historyRow(entry));
});

init();
