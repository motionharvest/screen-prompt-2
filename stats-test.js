// Tests for dictation stats and the year heatmap. Run with `npm test`.
const assert = require('assert');
const stats = require('./stats');

let failed = 0;
const check = (label, fn) => {
  try { fn(); }
  catch (err) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
  }
};

const now = new Date(2026, 8, 9, 15, 0, 0).getTime(); // Wed 9 Sep 2026 afternoon

check('countWords splits on whitespace', () => {
  assert.strictEqual(stats.countWords('  one two   three '), 3);
  assert.strictEqual(stats.countWords(''), 0);
});

check('identical transcripts are zero fixes', () => {
  assert.strictEqual(stats.countFixes('hello there', 'hello there'), 0);
});

check('dropped fillers count as fixes', () => {
  assert.strictEqual(stats.countFixes('Um hello there', 'hello there'), 1);
});

check('a substituted word counts as one fix', () => {
  assert.strictEqual(stats.countFixes('clawed code', 'Claude code'), 1);
});

check('dayKey is local YYYY-MM-DD', () => {
  assert.strictEqual(stats.dayKey(now), '2026-09-09');
});

check('addClip accumulates on the same day', () => {
  let days = {};
  days = stats.addClip(days, { at: now, words: 10, ms: 4000, fixes: 1 });
  days = stats.addClip(days, { at: now + 1000, words: 5, ms: 2000, fixes: 2 });
  assert.deepStrictEqual(days['2026-09-09'], { words: 15, ms: 6000, fixes: 3, clips: 2 });
});

check('pruneDays drops buckets older than STATS_DAYS', () => {
  const old = new Date(2026, 8, 9);
  old.setDate(old.getDate() - stats.STATS_DAYS - 2);
  let days = {};
  days = stats.addClip(days, { at: old.getTime(), words: 9, ms: 1000, fixes: 0 });
  days = stats.addClip(days, { at: now, words: 1, ms: 1000, fixes: 0 });
  assert.strictEqual(days['2026-09-09'].words, 1);
  assert.strictEqual(Object.keys(days).length, 1);
});

check('seedFromHistory counts words, not duration', () => {
  const days = stats.seedFromHistory([
    { at: now, text: 'one two three' },
    { at: now - 86400000, text: 'four' },
  ], now);
  assert.strictEqual(days['2026-09-09'].words, 3);
  assert.strictEqual(days['2026-09-09'].ms, 0);
  assert.strictEqual(days['2026-09-08'].clips, 1);
});

check('levelFor buckets words', () => {
  assert.strictEqual(stats.levelFor(0), 0);
  assert.strictEqual(stats.levelFor(1), 1);
  assert.strictEqual(stats.levelFor(24), 1);
  assert.strictEqual(stats.levelFor(25), 2);
  assert.strictEqual(stats.levelFor(100), 3);
  assert.strictEqual(stats.levelFor(250), 4);
});

check('heatmap is 53 weeks of Sunday–Saturday', () => {
  const weeks = stats.buildHeatmap({}, now);
  assert.strictEqual(weeks.length, stats.HEATMAP_WEEKS);
  assert.strictEqual(weeks[0].days.length, 7);
  assert.strictEqual(weeks[0].days[0].dow, 'Sunday');
  assert.strictEqual(weeks[0].days[6].dow, 'Saturday');
  const today = weeks.flatMap((w) => w.days).find((c) => c.today);
  assert.ok(today);
  assert.strictEqual(today.date, '2026-09-09');
  assert.strictEqual(today.dow, 'Wednesday');
});

check('heatmap month labels sit on weeks that contain the 1st', () => {
  const weeks = stats.buildHeatmap({}, now);
  const labeled = weeks.filter((w) => w.label);
  assert.ok(labeled.some((w) => w.label === 'Sep'));
  const sep = weeks.find((w) => w.days.some((d) => d.date === '2026-09-01'));
  assert.strictEqual(sep.label, 'Sep');
});

check('streak counts consecutive days, allowing an empty today', () => {
  let days = {};
  days = stats.addClip(days, { at: now - 86400000, words: 4, ms: 1000, fixes: 0 });
  days = stats.addClip(days, { at: now - 2 * 86400000, words: 4, ms: 1000, fixes: 0 });
  assert.strictEqual(stats.streak(days, now), 2);
  days = stats.addClip(days, { at: now, words: 4, ms: 1000, fixes: 0 });
  assert.strictEqual(stats.streak(days, now), 3);
});

check('summarize reports words, fixes and WPM from timed clips', () => {
  let days = {};
  days = stats.addClip(days, { at: now, words: 120, ms: 60000, fixes: 5 });
  const snap = stats.summarize(days, now);
  assert.strictEqual(snap.words, 120);
  assert.strictEqual(snap.fixes, 5);
  assert.strictEqual(snap.wpm, 120);
  assert.strictEqual(snap.weeks.length, stats.HEATMAP_WEEKS);
});

check('WPM is null when no clip has a duration', () => {
  const days = stats.seedFromHistory([{ at: now, text: 'hello there' }], now);
  assert.strictEqual(stats.summarize(days, now).wpm, null);
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
