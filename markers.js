const CUE_WORDS = ['this' /*, 'here'*/];
const CUE_RE = new RegExp(`\\b(?:${CUE_WORDS.join('|')})\\b`, 'gi');

function cues(text) {
  if (!text) return [];
  const found = String(text).match(CUE_RE);
  return found ? found.map((word) => word.toLowerCase()) : [];
}

function countCues(text) {
  return cues(text).length;
}

function createCueCounter() {
  let marked = 0;
  return {
    take(text) {
      const all = cues(text);
      if (all.length <= marked) return [];
      const fresh = all.slice(marked);
      marked = all.length;
      return fresh;
    },
    get marked() { return marked; },
  };
}

function sampleAt(history, time) {
  if (!history || !history.length) return null;
  let best = null;
  for (const sample of history) {
    if (sample.t > time) break;
    best = sample;
  }
  return best || history[0];
}

function trimHistory(history, now, keepMs) {
  while (history.length && now - history[0].t > keepMs) history.shift();
  return history;
}

module.exports = { CUE_WORDS, cues, countCues, createCueCounter, sampleAt, trimHistory };
