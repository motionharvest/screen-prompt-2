const $ = (id) => document.getElementById(id);

let capturing = false;
let currentPretty = '';

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

async function init() {
  const state = await window.api.getState();
  showStatus(state);
  applyPlatform(state.platform);
  document.querySelector(`input[name="mode"][value="${state.settings.mode}"]`).checked = true;
  document.querySelector(`input[name="output"][value="${state.settings.output}"]`).checked = true;
  document.querySelector(`input[name="theme"][value="${state.settings.theme}"]`).checked = true;
  $('sounds').checked = state.settings.sounds;
  $('startup').checked = state.settings.launchAtStartup;
  $('tidy').checked = state.settings.tidy;
  $('keep-mic-warm').checked = state.settings.keepMicWarm;
  keywords = (state.settings.keywords || []).map((k) => ({ ...k }));
  renderKeywords();
  $('duck').checked = state.settings.duck;
  showDuck(state.settings.duck, levelToReduction(state.settings.duckLevel));
  if (state.lastText) $('last-text').value = state.lastText;
}

for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener('change', () => window.api.setSettings({ mode: input.value }));
}
for (const input of document.querySelectorAll('input[name="output"]')) {
  input.addEventListener('change', () => window.api.setSettings({ output: input.value }));
}
for (const input of document.querySelectorAll('input[name="theme"]')) {
  input.addEventListener('change', () => window.api.setSettings({ theme: input.value }));
}
$('tidy').addEventListener('change', (e) => window.api.setSettings({ tidy: e.target.checked }));
$('keep-mic-warm').addEventListener('change', (e) => window.api.setSettings({ keepMicWarm: e.target.checked }));
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

// Click the box to put the text back on the clipboard — the usual reason to
// look at it is that something else has since overwritten the clipboard.
let copyTimer = null;
$('last-text').addEventListener('click', async () => {
  const text = $('last-text').value;
  if (!text) return;
  await window.api.copyText(text);
  const note = $('copy-note');
  note.classList.add('show');
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => note.classList.remove('show'), 1300);
});

window.api.onState(showStatus);
window.api.onTranscription(({ text }) => { $('last-text').value = text; });

init();
