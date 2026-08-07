// Tests for the shortcut matcher. Run with `npm test`.
//
// Same approach as tidy-test.js: the class lives in main.js, which cannot be
// required without Electron, so the section is lifted out and evaluated on its
// own against stubbed `settings`, `MOD_GROUPS` and `trace`. The tests run the
// shipping code rather than a copy of it.
//
// This exists because the matcher decides when recording starts, and the rules
// are not obvious: a lone modifier is both a shortcut and the Ctrl of Ctrl+C,
// so it fires on the press and is undone again if a combination materialises.
// Every case below is one that broke, or would have.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { UiohookKey } = require('uiohook-napi');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('class ShortcutMatcher {');
const end = src.indexOf('// -------------------------------------------------------- shortcut capture --');
if (start < 0 || end < 0) {
  console.error('shortcut-test: section markers moved in main.js');
  process.exit(1);
}

const MOD_GROUPS = new Map([
  [UiohookKey.Ctrl, 'ctrl'], [UiohookKey.CtrlRight, 'ctrl'],
  [UiohookKey.Alt, 'alt'], [UiohookKey.AltRight, 'alt'],
  [UiohookKey.Shift, 'shift'], [UiohookKey.ShiftRight, 'shift'],
  [UiohookKey.Meta, 'meta'], [UiohookKey.MetaRight, 'meta'],
]);

const RCTRL = UiohookKey.CtrlRight;
const LCTRL = UiohookKey.Ctrl;
const SHIFT = UiohookKey.Shift;
const ALT = UiohookKey.Alt;
const KEY_C = UiohookKey.C;
const KEY_D = UiohookKey.D;

// One fresh matcher per case, with a log of the callbacks it fired.
function build({ shortcut, mode }) {
  const ctx = {
    module: {}, console,
    MOD_GROUPS,
    settings: { shortcut, mode },
    trace: () => { },
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nmodule.exports = ShortcutMatcher;', ctx);
  const Matcher = ctx.module.exports;

  const events = [];
  const matcher = new Matcher(
    () => events.push('press'),
    () => events.push('release'),
    () => events.push('abort'),
  );
  return { matcher, events };
}

const LONE_RCTRL = { mods: [], keycode: RCTRL, keyName: 'Right Ctrl', isModifier: true };
const COMBO_CTRL_ALT_D = { mods: ['ctrl', 'alt'], keycode: KEY_D, keyName: 'D', isModifier: false };

const cases = [
  // ---- the change: a lone modifier in toggle mode fires on the press --------
  ['lone modifier, toggle: fires on press, not release',
    { shortcut: LONE_RCTRL, mode: 'toggle' },
    (m) => { m.keydown(RCTRL); m.keyup(RCTRL); },
    ['press']],

  ['lone modifier, toggle: two taps are two presses (start then stop)',
    { shortcut: LONE_RCTRL, mode: 'toggle' },
    (m) => { m.keydown(RCTRL); m.keyup(RCTRL); m.keydown(RCTRL); m.keyup(RCTRL); },
    ['press', 'press']],

  // ---- ...and the cost of that: combinations have to be undone -------------
  ['Right Ctrl + C aborts the speculative start',
    { shortcut: LONE_RCTRL, mode: 'toggle' },
    (m) => { m.keydown(RCTRL); m.keydown(KEY_C); m.keyup(KEY_C); m.keyup(RCTRL); },
    ['press', 'abort']],

  ['abort fires once even if more keys follow',
    { shortcut: LONE_RCTRL, mode: 'toggle' },
    (m) => { m.keydown(RCTRL); m.keydown(KEY_C); m.keydown(KEY_D); m.keyup(RCTRL); },
    ['press', 'abort']],

  // ---- things that must NOT fire ------------------------------------------
  ['Left Ctrl + C is not our shortcut at all',
    { shortcut: LONE_RCTRL, mode: 'toggle' },
    (m) => { m.keydown(LCTRL); m.keydown(KEY_C); m.keyup(KEY_C); m.keyup(LCTRL); },
    []],

  ['Right Ctrl while Shift is held is not a lone press',
    { shortcut: LONE_RCTRL, mode: 'toggle' },
    (m) => { m.keydown(SHIFT); m.keydown(RCTRL); m.keyup(RCTRL); m.keyup(SHIFT); },
    []],

  ['a repeated key-down does not toggle off and back on',
    { shortcut: LONE_RCTRL, mode: 'toggle' },
    (m) => { m.keydown(RCTRL); m.keydown(RCTRL); m.keydown(RCTRL); m.keyup(RCTRL); },
    ['press']],

  ['disabled matcher (shortcut capture is open) fires nothing',
    { shortcut: LONE_RCTRL, mode: 'toggle' },
    (m) => { m.enabled = false; m.keydown(RCTRL); m.keyup(RCTRL); },
    []],

  // ---- hold mode still brackets the recording -----------------------------
  ['lone modifier, hold: press then release',
    { shortcut: LONE_RCTRL, mode: 'hold' },
    (m) => { m.keydown(RCTRL); m.keyup(RCTRL); },
    ['press', 'release']],

  ['hold mode does not abort — release already ends the recording',
    { shortcut: LONE_RCTRL, mode: 'hold' },
    (m) => { m.keydown(RCTRL); m.keydown(KEY_C); m.keyup(KEY_C); m.keyup(RCTRL); },
    ['press', 'release']],

  // ---- combination shortcuts were always press-triggered -------------------
  ['Ctrl+Alt+D fires on the D press',
    { shortcut: COMBO_CTRL_ALT_D, mode: 'toggle' },
    (m) => { m.keydown(LCTRL); m.keydown(ALT); m.keydown(KEY_D); m.keyup(KEY_D); m.keyup(ALT); m.keyup(LCTRL); },
    ['press', 'release']],

  ['Ctrl+Alt+D does not fire with a modifier missing',
    { shortcut: COMBO_CTRL_ALT_D, mode: 'toggle' },
    (m) => { m.keydown(LCTRL); m.keydown(KEY_D); m.keyup(KEY_D); m.keyup(LCTRL); },
    []],

  ['held D repeats do not re-fire',
    { shortcut: COMBO_CTRL_ALT_D, mode: 'toggle' },
    (m) => { m.keydown(LCTRL); m.keydown(ALT); m.keydown(KEY_D); m.keydown(KEY_D); m.keyup(KEY_D); },
    ['press', 'release']],

  // ---- both sides of a modifier group -------------------------------------
  ['releasing Left Ctrl while Right Ctrl is still down keeps the group held',
    { shortcut: COMBO_CTRL_ALT_D, mode: 'toggle' },
    (m) => {
      m.keydown(LCTRL); m.keydown(RCTRL); m.keyup(LCTRL);
      m.keydown(ALT); m.keydown(KEY_D);
    },
    ['press']],
];

let failed = 0;
for (const [name, config, drive, expected] of cases) {
  const { matcher, events } = build(config);
  drive(matcher);
  const got = JSON.stringify(events);
  const want = JSON.stringify(expected);
  if (got !== want) {
    failed += 1;
    console.error(`FAIL  ${name}\n      expected ${want}\n      got      ${got}`);
  }
}

if (failed) {
  console.error(`\n${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`all ${cases.length} passed`);
