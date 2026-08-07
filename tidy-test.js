// Tests for the transcript tidying. Run with `npm test`.
//
// The tidying lives in main.js, which cannot be required without Electron, so
// the section between the FILLERS list and the state machine is lifted out and
// evaluated on its own. That keeps the tests honest — they run the shipping
// code, not a copy of it — at the cost of caring where the section markers are.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('const FILLERS = new Set');
const end = src.indexOf('// ------------------------------------------------------------ state machine --');
const ctx = { module: {}, console };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + '\nmodule.exports = tidyTranscript;', ctx);
const tidy = ctx.module.exports;

const cases = [
  // the three things asked for
  ['Um it does need to know how um to delete the word.',
   'It does need to know how to delete the word.'],
  ['I I I am a slow thinker.', 'I am a slow thinker.'],
  ['This is  a   test   with gaps.', 'This is a test with gaps.'],

  // real sentences from this session's dictation
  ['This seems to have a timeout. Um I I I am a slow thinker and I needed to not automatically uh decide to close itself.',
   'This seems to have a timeout. I am a slow thinker and I needed to not automatically decide to close itself.'],
  ['So if I move from one curt one monitor to the other, that little thing moves.',
   'So if I move from one curt one monitor to the other, that little thing moves.'],
  ['Uh The uh The stario naturally gets reduced.', 'The stario naturally gets reduced.'],

  // punctuation handed back by a dropped filler
  ['So um. Yeah that works.', 'So. Yeah that works.'],
  ['So, um, yeah.', 'So, yeah.'],
  ['Um, the thing is broken.', 'The thing is broken.'],
  ['Well um... maybe.', 'Well... maybe.'],

  // contraction restarts
  ["I I'm not sure.", "I'm not sure."],
  ["we we've done it.", "we've done it."],
  ["it it's fine.", "it's fine."],
  ['I I’m not sure.', 'I’m not sure.'],          // curly apostrophe
  ['we we’ve done it.', 'we’ve done it.'],

  // capitalisation carried across a collapsed repeat
  ['The the thing is broken.', 'The thing is broken.'],
  ['Yeah. The the thing.', 'Yeah. The thing.'],

  // deliberate repeats that must survive
  ['He had had enough.', 'He had had enough.'],
  ['I know that that is true.', 'I know that that is true.'],
  ['It was very very good.', 'It was very very good.'],
  ['No no no, stop.', 'No no no, stop.'],

  // things that only look like fillers
  ['I am um.', 'I am.'],
  ['Um.', ''],
  ['um uh um uh', ''],
  ['', ''],

  // cut-off restarts — the real output that prompted this
  ['Alright, so it seems to be working okay. I d I don’t know how to test it, so I g I guess that I’ll just see what this does.',
   'Alright, so it seems to be working okay. I don’t know how to test it, so I guess that I’ll just see what this does.'],
  ["I d I don't know.", "I don't know."],
  ['so I g I guess that', 'so I guess that'],
  ['I d do I don\'t know.', "I don't know."],
  ['We wa I want to leave.', 'We wa I want to leave.'],   // no bracketing repeat: left alone

  // the false positives a bare prefix rule would cause
  ['The theme was good.', 'The theme was good.'],
  ['So something happened.', 'So something happened.'],
  ['I am I am here.', 'I am I am here.'],                 // phrase repeat, out of scope
  ['No no no, stop.', 'No no no, stop.'],
  ['Go in into the house.', 'Go in into the house.'],

  // must not touch ordinary text
  ['The quick brown fox jumps over the lazy dog.',
   'The quick brown fox jumps over the lazy dog.'],
  ['Humming birds are not fillers, nor is Uhura.',
   'Humming birds are not fillers, nor is Uhura.'],
];

let failed = 0;
for (const [input, want] of cases) {
  const got = tidy(input);
  if (got !== want) {
    failed++;
    console.log(`FAIL  in:   ${JSON.stringify(input)}`);
    console.log(`      want: ${JSON.stringify(want)}`);
    console.log(`      got:  ${JSON.stringify(got)}`);
  }
}
console.log(failed ? `\n${failed}/${cases.length} failed` : `all ${cases.length} passed`);
process.exit(failed ? 1 : 0);
