// Tests for the macros a "keys" keyword runs. Run with `npm test`.
//
// Same approach as tidy-test.js and shortcut-test.js: the section lives in
// main.js, which cannot be required without Electron, so it is lifted out by
// its markers and evaluated against a stubbed key-naming table. The tests run
// the shipping code rather than a copy of it.
//
// What is being protected here is a round trip. A combination is recorded from
// uiohook keycodes, written to the settings file as text, read back, and sent
// as the same physical key. Every step in that loop is in this file, and the
// last test walks the whole of uiohook's key table through it — because a name
// that survives being written down but comes back as a different key is a
// keyword that quietly presses the wrong thing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { UiohookKey } = require('uiohook-napi');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('// ----------------------------------------------------------------- macros --');
const end = src.indexOf('// ------------------------------------------------------------------ trace --');
if (start < 0 || end < 0) {
  console.error('macro-test: section markers moved in main.js');
  process.exit(1);
}

const KEYCODE_NAMES = new Map();
for (const [name, code] of Object.entries(UiohookKey)) {
  if (!KEYCODE_NAMES.has(code)) KEYCODE_NAMES.set(code, name);
}

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'];
const MOD_PRETTY = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };

// The one function the section borrows from outside it. Kept to the Windows
// spelling so the expected strings below are readable.
function prettyKeyName(keycode) {
  const name = KEYCODE_NAMES.get(keycode) || `key ${keycode}`;
  const sides = {
    Ctrl: 'Left Ctrl', CtrlRight: 'Right Ctrl',
    Alt: 'Left Alt', AltRight: 'Right Alt',
    Shift: 'Left Shift', ShiftRight: 'Right Shift',
    Meta: 'Left Win', MetaRight: 'Right Win',
  };
  return sides[name] || name.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
}

const ctx = { module: {}, console, KEYCODE_NAMES, MOD_ORDER, MOD_PRETTY, prettyKeyName };
vm.createContext(ctx);
vm.runInContext(
  src.slice(start, end)
  + '\nmodule.exports = { chordText, parseChord, parseMacro, prettyMacro };',
  ctx,
);
const { chordText, parseChord, parseMacro, prettyMacro } = ctx.module.exports;

let failed = 0;
let ran = 0;

function check(what, got, want) {
  ran++;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) return;
  failed++;
  console.log(`FAIL  ${what}`);
  console.log(`      want: ${b}`);
  console.log(`      got:  ${a}`);
}

// Writing a chord down.
check('a chord with modifiers',
  chordText({ mods: ['ctrl', 'shift'], keycode: UiohookKey.P }), 'ctrl+shift+p');
check('modifiers are written in one order however they were held',
  chordText({ mods: ['shift', 'ctrl'], keycode: UiohookKey.P }), 'ctrl+shift+p');
check('a bare key', chordText({ mods: [], keycode: UiohookKey.F5 }), 'f5');
check('a named key', chordText({ mods: ['alt'], keycode: UiohookKey.ArrowLeft }), 'alt+arrowleft');
check('a modifier recorded on its own',
  chordText({ mods: [], keycode: UiohookKey.Ctrl }), 'ctrl');
check('a key uiohook does not name', chordText({ mods: [], keycode: 0xabcd }), null);

// Reading one back.
check('reading a chord', parseChord('ctrl+shift+p'),
  { mods: ['ctrl', 'shift'], key: 'p', keycode: UiohookKey.P });
check('modifiers are ordered on the way in too', parseChord('shift+ctrl+p'),
  { mods: ['ctrl', 'shift'], key: 'p', keycode: UiohookKey.P });
check('case is ignored', parseChord('Ctrl+P'),
  { mods: ['ctrl'], key: 'p', keycode: UiohookKey.P });
check('the last part is the key, so a bare ctrl is the Ctrl key',
  parseChord('ctrl'), { mods: [], key: 'ctrl', keycode: UiohookKey.Ctrl });
check('a repeated modifier', parseChord('ctrl+ctrl+p'), null);
check('a key where a modifier belongs', parseChord('ctrl+p+q'), null);
check('a name nothing answers to', parseChord('banana'), null);
check('a trailing plus', parseChord('ctrl+'), null);
check('a leading plus', parseChord('+p'), null);
check('nothing at all', parseChord(''), null);

// Whole macros.
check('one step', parseMacro('ctrl+shift+p').length, 1);
check('a sequence', parseMacro('ctrl+k ctrl+d').map((c) => c.key), ['k', 'd']);
check('surrounding space', parseMacro('   f5   ').map((c) => c.key), ['f5']);
check('an empty macro', parseMacro(''), null);
check('one unreadable step spoils the whole macro', parseMacro('ctrl+k banana'), null);
check('more steps than a macro may have',
  parseMacro(new Array(33).fill('f5').join(' ')), null);
check('exactly as many steps as a macro may have',
  parseMacro(new Array(32).fill('f5').join(' ')).length, 32);

// Waits.
check('a wait between two presses',
  parseMacro('ctrl+c 400ms ctrl+v').map((s) => s.kind), ['keys', 'wait', 'keys']);
check('how long to wait', parseMacro('ctrl+c 400ms ctrl+v')[1].ms, 400);
check('a wait first, before anything is pressed',
  parseMacro('250ms enter').map((s) => s.kind), ['wait', 'keys']);
check('a wait of no time at all', parseMacro('0ms')[0], { kind: 'wait', ms: 0 });
check('the longest wait allowed', parseMacro('10000ms')[0].ms, 10000);
check('a wait longer than that spoils the macro', parseMacro('10001ms'), null);
check('a number is not a wait without its unit', parseMacro('400'), null);
check('a unit is not a wait without its number', parseMacro('ms'), null);
check('a wait is not a key, so it cannot take a modifier',
  parseMacro('ctrl+400ms'), null);

// What the overlay shows. It has room for about twenty characters, so one
// combination is spelled out and a macro says how much of it ran.
check('one combination read back for a person',
  prettyMacro('ctrl+shift+p'), 'Ctrl + Shift + P');
check('a macro read back for a person', prettyMacro('ctrl+c 400ms ctrl+v'), '3 steps');
check('two presses are still a macro', prettyMacro('ctrl+k ctrl+d'), '2 steps');
check('a lone wait is a macro too', prettyMacro('400ms'), '1 step');
check('an unreadable target is shown as written', prettyMacro('banana'), 'banana');

// The invariant the whole feature rests on: every key uiohook can report can
// be written down and read back as the same key.
const lost = [];
for (const keycode of KEYCODE_NAMES.keys()) {
  const text = chordText({ mods: ['ctrl'], keycode });
  const back = text && parseChord(text);
  if (!back || back.keycode !== keycode || back.mods.join() !== 'ctrl') {
    lost.push(`${KEYCODE_NAMES.get(keycode)} -> ${text} -> ${back && back.keycode}`);
  }
}
check(`all ${KEYCODE_NAMES.size} named keys survive the round trip`, lost, []);

console.log(failed ? `\n${failed}/${ran} failed` : `all ${ran} passed`);
process.exit(failed ? 1 : 0);
