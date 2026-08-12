// Tests for the transcript history — retention, order and the cap.
// Run with `npm test`.
//
// Lifted out of main.js the same way tidy-test.js lifts the tidying, so these
// run the shipping code rather than a copy of it. Only `fs` and `app` are
// stubbed: the point is what the list does, not where it is written.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('const HISTORY_PATH = ');
const end = src.indexOf('// ------------------------------------------------------------- auto-start --');

const written = [];
const ctx = {
  console, path,
  app: { getPath: () => '/tmp/screen-prompt-2-test' },
  fs: {
    readFileSync: () => { throw new Error('no file'); },
    writeFileSync: (_p, data) => written.push(data),
    mkdirSync: () => { },
    unlinkSync: () => { },
  },
  module: {},
};
vm.createContext(ctx);
vm.runInContext(src.slice(start, end)
  + '\nmodule.exports = { pruneHistory, rememberTranscript, HISTORY_DAYS, HISTORY_MAX,'
  + ' get history() { return history; }, set history(v) { history = v; } };', ctx);
const h = ctx.module.exports;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
let failed = 0;
const check = (label, got, expected) => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      expected ${JSON.stringify(expected)}`);
    console.error(`      got      ${JSON.stringify(got)}`);
  }
};

check('retention is 30 days', h.HISTORY_DAYS, 30);

// Anything older than the retention window is dropped; anything inside it stays.
check('drops entries past the window',
  h.pruneHistory([
    { at: now - 1 * DAY, text: 'yesterday' },
    { at: now - 29.5 * DAY, text: 'just inside' },
    { at: now - 31 * DAY, text: 'too old' },
    { at: now - 400 * DAY, text: 'much too old' },
  ]).map((e) => e.text),
  ['yesterday', 'just inside']);

// Newest first, whatever order they arrive in.
check('newest first',
  h.pruneHistory([
    { at: now - 5 * DAY, text: 'middle' },
    { at: now - 10 * DAY, text: 'oldest' },
    { at: now, text: 'newest' },
  ]).map((e) => e.text),
  ['newest', 'middle', 'oldest']);

// A file written by hand, or by a future build, cannot break the list.
check('drops entries that are not transcripts',
  h.pruneHistory([
    null,
    'a bare string',
    { text: 'no timestamp' },
    { at: now },
    { at: 'not a number', text: 'bad timestamp' },
    { at: now, text: '' },
    { at: now, text: 'the only good one', extra: 'ignored' },
  ]),
  [{ at: now, text: 'the only good one' }]);

// Only the two fields are kept, so nothing a future build adds leaks back out.
check('keeps only at and text',
  Object.keys(h.pruneHistory([{ at: now, text: 'x', verb: 'Pasted' }])[0]),
  ['at', 'text']);

const overfull = Array.from({ length: h.HISTORY_MAX + 50 }, (_, i) => ({ at: now - i, text: `n${i}` }));
const capped = h.pruneHistory(overfull);
check('capped at HISTORY_MAX', capped.length, h.HISTORY_MAX);
check('the cap drops the oldest, not the newest', capped[0].text, 'n0');

// The whole point of the store: a new transcript goes on top and is written out.
ctx.module.exports.history = [{ at: now - DAY, text: 'older' }];
written.length = 0;
const entry = h.rememberTranscript('the new one');
check('new entry is returned', entry.text, 'the new one');
check('new entry goes on top', h.history.map((e) => e.text), ['the new one', 'older']);
check('the list was written to disk', written.length, 1);
check('what was written is the list', JSON.parse(written[0]).map((e) => e.text),
  ['the new one', 'older']);

// A remember that pushes past the window prunes at the same time.
ctx.module.exports.history = [{ at: now - 31 * DAY, text: 'expired' }];
h.rememberTranscript('fresh');
check('remembering prunes the expired', h.history.map((e) => e.text), ['fresh']);

console.log(failed ? `${failed} failed` : 'all 12 passed');
process.exit(failed ? 1 : 0);
