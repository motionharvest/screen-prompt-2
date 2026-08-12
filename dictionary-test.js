// Tests for the dictionary — the spoken-word to spelled-word replacements.
// Run with `npm test`.
//
// Loaded the same way tidy-test.js loads the tidying: main.js cannot be
// required without Electron, so the section between the FILLERS list and the
// state machine is lifted out and evaluated on its own. These run the shipping
// code, not a copy of it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('const FILLERS = new Set');
const end = src.indexOf('// ------------------------------------------------------------ state machine --');
const ctx = { module: {}, console };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + '\nmodule.exports = applyDictionary;', ctx);
const apply = ctx.module.exports;

const CLAUDE = [{ from: 'clawed', to: 'Claude' }];

const cases = [
  // the thing it is for
  [CLAUDE, 'I asked clawed to do it.', 'I asked Claude to do it.'],
  [CLAUDE, 'clawed', 'Claude'],
  [CLAUDE, 'Nothing to replace here.', 'Nothing to replace here.'],
  [[], 'clawed stays put without an entry.', 'clawed stays put without an entry.'],

  // case is ignored when listening
  [CLAUDE, 'Clawed is running.', 'Claude is running.'],
  [CLAUDE, 'CLAWED IS LOUD.', 'Claude IS LOUD.'],

  // whole words only
  [CLAUDE, 'The declawed cat.', 'The declawed cat.'],
  [CLAUDE, 'clawedish is not a word.', 'clawedish is not a word.'],
  [CLAUDE, 'Ask clawed, then wait.', 'Ask Claude, then wait.'],
  [CLAUDE, 'Ask (clawed) about it.', 'Ask (Claude) about it.'],
  [CLAUDE, "clawed's answer.", "Claude's answer."],

  // every occurrence, not just the first
  [CLAUDE, 'clawed and clawed again.', 'Claude and Claude again.'],

  // phrases, and the longest entry winning wherever both could match
  [[{ from: 'clawed', to: 'Claude' }, { from: 'clawed code', to: 'Claude Code' }],
    'I run clawed code in clawed.', 'I run Claude Code in Claude.'],
  [[{ from: 'clawed code', to: 'Claude Code' }, { from: 'clawed', to: 'Claude' }],
    'I run clawed code in clawed.', 'I run Claude Code in Claude.'],
  // however much space the model put between the words
  [[{ from: 'clawed code', to: 'Claude Code' }], 'run clawed  code now', 'run Claude Code now'],

  // one pass: a replacement is never fed back through the other rules
  [[{ from: 'alpha', to: 'beta' }, { from: 'beta', to: 'gamma' }],
    'alpha beta', 'beta gamma'],
  // ...including a rule whose replacement contains its own trigger
  [[{ from: 'cat', to: 'cat food' }], 'the cat sat', 'the cat food sat'],

  // spelling is used exactly as written when it has capitals of its own
  [[{ from: 'iphone', to: 'iPhone' }], 'Iphone screens are bright.', 'iPhone screens are bright.'],
  [[{ from: 'iphone', to: 'iPhone' }], 'my iphone', 'my iPhone'],
  [[{ from: 'github', to: 'GitHub' }], 'Github is down.', 'GitHub is down.'],
  // ...and an all-lowercase spelling takes the capital of the word it replaces
  [[{ from: 'definately', to: 'definitely' }], 'Definately not.', 'Definitely not.'],
  [[{ from: 'definately', to: 'definitely' }], 'It is definately fine.', 'It is definitely fine.'],

  // the apostrophe the model used is not necessarily the one you typed
  [[{ from: "don't", to: 'do not' }], 'I don’t think so.', 'I do not think so.'],
  [[{ from: 'don’t', to: 'do not' }], "I don't think so.", 'I do not think so.'],

  // half-filled rows are kept in settings but never match
  [[{ from: 'clawed', to: '' }], 'clawed stays.', 'clawed stays.'],
  [[{ from: '', to: 'Claude' }], 'nothing happens here.', 'nothing happens here.'],
  [[{ from: '  ', to: '  ' }], 'still nothing.', 'still nothing.'],

  // a spelling that begins with tight punctuation takes the space with it
  [[{ from: 'dot com', to: '.com' }], 'example dot com', 'example.com'],
  [[{ from: 'comma', to: ',' }], 'hello comma then goodbye', 'hello, then goodbye'],
  [[{ from: 'dot com', to: '.com' }], 'dot com at the start', '.com at the start'],

  // regex metacharacters in an entry are literal text, not syntax
  [[{ from: 'c++', to: 'C++' }], 'i write c++ daily', 'i write C++ daily'],
  [[{ from: 'a.b', to: 'ab' }], 'axb is untouched', 'axb is untouched'],

  // non-ASCII words have word boundaries too
  [[{ from: 'cafe', to: 'café' }], 'the cafe is open', 'the café is open'],
  [[{ from: 'jose', to: 'José' }], 'Jose said hello', 'José said hello'],
];

let failed = 0;
for (const [entries, input, expected] of cases) {
  const got = apply(input, entries);
  if (got !== expected) {
    failed++;
    console.error(`FAIL  ${JSON.stringify(input)}`);
    console.error(`      entries  ${JSON.stringify(entries)}`);
    console.error(`      expected ${JSON.stringify(expected)}`);
    console.error(`      got      ${JSON.stringify(got)}`);
  }
}

// The dictionary must not disturb a transcript that has nothing to replace,
// however many entries are loaded — the common case is a long list and a
// sentence that matches none of it.
const many = Array.from({ length: 200 }, (_, i) => ({ from: `word${i}`, to: `Word${i}` }));
const untouched = 'A sentence with none of those in it at all.';
if (apply(untouched, many) !== untouched) {
  failed++;
  console.error('FAIL  a large dictionary changed a sentence it should not have');
}

console.log(failed ? `${failed} failed` : `all ${cases.length + 1} passed`);
process.exit(failed ? 1 : 0);
