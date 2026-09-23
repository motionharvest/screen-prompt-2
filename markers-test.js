const assert = require('assert');
const { countCues, createCueCounter, sampleAt, trimHistory } = require('./markers');

let failed = 0;
const check = (label, fn) => {
  try { fn(); }
  catch (err) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
  }
};

check('both cue words count, whatever their case', () => {
  assert.strictEqual(countCues('This goes here'), 2);
  assert.strictEqual(countCues('HERE, this and this'), 3);
});

check('a cue word inside another word is not a cue word', () => {
  assert.strictEqual(countCues('thistle adhere therein'), 0);
  assert.strictEqual(countCues('this. here? "this"'), 3);
});

check('nothing to count in nothing', () => {
  assert.strictEqual(countCues(''), 0);
  assert.strictEqual(countCues(null), 0);
  assert.strictEqual(countCues(undefined), 0);
});

check('a partial that arrives again places no second number', () => {
  const counter = createCueCounter();
  assert.deepStrictEqual(counter.take('move this'), ['this']);
  assert.deepStrictEqual(counter.take('move this'), []);
  assert.deepStrictEqual(counter.take('move this over'), []);
  assert.deepStrictEqual(counter.take('move this over here'), ['here']);
  assert.strictEqual(counter.marked, 2);
});

check('each new cue says which word it was, in the order spoken', () => {
  const counter = createCueCounter();
  assert.deepStrictEqual(counter.take('Here, take THIS'), ['here', 'this']);
  assert.deepStrictEqual(counter.take('Here, take THIS and this'), ['this']);
});

check('a word the model revises away leaves its number alone', () => {
  const counter = createCueCounter();
  assert.deepStrictEqual(counter.take('put this here'), ['this', 'here']);
  assert.deepStrictEqual(counter.take('put it there'), []);
  assert.deepStrictEqual(counter.take('put it there and this'), []);
  assert.deepStrictEqual(counter.take('put it there and this and here and this'), ['this']);
});

check('a whole segment arriving at once numbers every cue word in it', () => {
  const counter = createCueCounter();
  assert.deepStrictEqual(counter.take('this here this here'),
    ['this', 'here', 'this', 'here']);
});

check('a reading is found by the time it was taken', () => {
  const history = [
    { x: 10, y: 10, t: 1000 },
    { x: 20, y: 20, t: 1100 },
    { x: 30, y: 30, t: 1200 },
  ];
  assert.deepStrictEqual(sampleAt(history, 1150), { x: 20, y: 20, t: 1100 });
  assert.deepStrictEqual(sampleAt(history, 1100), { x: 20, y: 20, t: 1100 });
  assert.deepStrictEqual(sampleAt(history, 9999), { x: 30, y: 30, t: 1200 });
});

check('a time older than anything known gives the oldest reading', () => {
  const history = [{ x: 10, y: 10, t: 1000 }, { x: 20, y: 20, t: 1100 }];
  assert.deepStrictEqual(sampleAt(history, 500), { x: 10, y: 10, t: 1000 });
  assert.strictEqual(sampleAt([], 500), null);
  assert.strictEqual(sampleAt(null, 500), null);
});

check('the history keeps only what a lookup can still ask for', () => {
  const history = [
    { x: 1, y: 1, t: 1000 },
    { x: 2, y: 2, t: 2000 },
    { x: 3, y: 3, t: 4000 },
  ];
  trimHistory(history, 4000, 2500);
  assert.deepStrictEqual(history.map((s) => s.t), [2000, 4000]);
});

if (failed) {
  console.error(`\n${failed} marker test(s) failed`);
  process.exit(1);
}
console.log('markers: all tests passed');
