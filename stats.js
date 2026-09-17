// Daily dictation stats and the year heatmap. Pure functions so the tests
// can run without Electron. Persistence lives in main.js.

const STATS_DAYS = 400;
const HEATMAP_WEEKS = 53;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function countWords(text) {
  return words(text).length;
}

// Word-level edit distance between what the model said and what was delivered
// after tidying and the dictionary. Each insert, delete or substitution is
// one fix.
function countFixes(raw, final) {
  const a = words(raw);
  const b = words(final);
  if (a.length === 0 && b.length === 0) return 0;
  const n = a.length;
  const m = b.length;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function keyToLocalMs(key) {
  const parts = String(key).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return NaN;
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function emptyDay() {
  return { words: 0, ms: 0, fixes: 0, clips: 0 };
}

function addClip(days, clip) {
  const next = { ...days };
  const key = dayKey(clip.at);
  const rec = { ...(next[key] || emptyDay()) };
  rec.words += Math.max(0, clip.words || 0);
  rec.ms += Math.max(0, clip.ms || 0);
  rec.fixes += Math.max(0, clip.fixes || 0);
  rec.clips += 1;
  next[key] = rec;
  return pruneDays(next, clip.at);
}

function pruneDays(days, nowMs) {
  const cutoff = addDays(startOfLocalDay(nowMs), -STATS_DAYS);
  const next = {};
  for (const [key, rec] of Object.entries(days || {})) {
    const at = keyToLocalMs(key);
    if (!Number.isFinite(at) || at < cutoff) continue;
    next[key] = {
      words: rec.words || 0,
      ms: rec.ms || 0,
      fixes: rec.fixes || 0,
      clips: rec.clips || 0,
    };
  }
  return next;
}

// Used once, when stats.json is missing, so the grid is not blank for someone
// who already has a month of transcripts.
function seedFromHistory(history, nowMs) {
  let days = {};
  for (const entry of history || []) {
    if (!entry || !entry.text || !Number.isFinite(entry.at)) continue;
    days = addClip(days, {
      at: entry.at,
      words: countWords(entry.text),
      ms: 0,
      fixes: 0,
    });
  }
  return pruneDays(days, nowMs);
}

function levelFor(wordCount) {
  if (wordCount <= 0) return 0;
  if (wordCount < 25) return 1;
  if (wordCount < 100) return 2;
  if (wordCount < 250) return 3;
  return 4;
}

function sundayOnOrBefore(ms) {
  const d = new Date(startOfLocalDay(ms));
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

function buildHeatmap(days, nowMs) {
  const today = startOfLocalDay(nowMs);
  const thisSunday = sundayOnOrBefore(nowMs);
  const start = addDays(thisSunday, -(HEATMAP_WEEKS - 1) * 7);
  const weeks = [];
  let lastMonth = '';
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const weekStart = addDays(start, w * 7);
    const cells = [];
    for (let dow = 0; dow < 7; dow++) {
      const at = addDays(weekStart, dow);
      const key = dayKey(at);
      const rec = days[key] || emptyDay();
      cells.push({
        date: key,
        dow: DOW[dow],
        words: rec.words,
        level: at > today ? 0 : levelFor(rec.words),
        future: at > today,
        today: at === today,
      });
    }
    const firstOfMonth = cells.find((c) => c.date.endsWith('-01'));
    const month = new Date(weekStart).toLocaleString('en-US', { month: 'short' });
    let label = '';
    if (firstOfMonth) {
      label = new Date(keyToLocalMs(firstOfMonth.date)).toLocaleString('en-US', { month: 'short' });
    } else if (w === 0) {
      label = month;
    }
    if (label === lastMonth) label = '';
    if (label) lastMonth = label;
    weeks.push({ label, days: cells });
  }
  return weeks;
}

function streak(days, nowMs) {
  const today = startOfLocalDay(nowMs);
  let cursor = today;
  if (!(days[dayKey(cursor)] || emptyDay()).words) {
    cursor = addDays(cursor, -1);
  }
  let n = 0;
  while ((days[dayKey(cursor)] || emptyDay()).words > 0) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

function summarize(days, nowMs) {
  let wordsTotal = 0;
  let fixes = 0;
  let clips = 0;
  let timedWords = 0;
  let timedMs = 0;
  for (const rec of Object.values(days || {})) {
    wordsTotal += rec.words || 0;
    fixes += rec.fixes || 0;
    clips += rec.clips || 0;
    if (rec.ms > 0) {
      timedWords += rec.words || 0;
      timedMs += rec.ms;
    }
  }
  const minutes = timedMs / 60000;
  return {
    words: wordsTotal,
    fixes,
    clips,
    wpm: minutes > 0 ? Math.round(timedWords / minutes) : null,
    streak: streak(days, nowMs),
    weeks: buildHeatmap(days, nowMs),
  };
}

module.exports = {
  STATS_DAYS,
  HEATMAP_WEEKS,
  DOW,
  countWords,
  countFixes,
  dayKey,
  addClip,
  pruneDays,
  seedFromHistory,
  levelFor,
  buildHeatmap,
  streak,
  summarize,
};
