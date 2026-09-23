// Tests for the cursor trail's drawing. Run with `npm test`.
//
// renderer/trail.js is a renderer script rather than a module, so it is run
// here in a context with a fake document, a fake window and a canvas that
// records what it was asked to draw. What is checked is therefore the real
// thing — the same file the app loads, driven through the same two IPC
// callbacks main sends it — rather than a re-implementation of the geometry.
//
// The line is a ribbon: one filled four-sided piece per segment, plus a disc
// at the cursor end, plus one stroke of the whole path for the glow in the
// schemes that have one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (label, fn) => {
  try { fn(); }
  catch (err) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
  }
};

// The colours the trail reads out of theme.css, per scheme.
const VARS = {
  default: { '--bar-top': '#f0a878', '--bar-bottom': '#d8825a', '--bar-glow': 'none' },
  synthwave: {
    '--bar-top': '#22e0ff', '--bar-bottom': '#ff2e97',
    '--bar-glow': 'rgba(255, 46, 151, 0.55)',
  },
};

// A canvas context that keeps every fill and stroke. fillStyle is the one
// property that has to behave like the real thing: trail.js parses colours by
// assigning them and reading back the normalised form, so this normalises the
// same way.
function recordingContext(ops) {
  let fill = '#000000';
  return {
    set fillStyle(v) {
      if (v.startsWith('#')) {
        fill = v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join('')}` : v.toLowerCase();
      } else fill = v.replace(/\s+/g, ' ');
    },
    get fillStyle() { return fill; },
    strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    shadowColor: '', shadowBlur: 0, globalAlpha: 1,
    setTransform() { }, save() { }, restore() { },
    clearRect(x, y, w, h) { ops.push({ op: 'clear', x, y, w, h }); },
    beginPath() { this.path = []; this.disc = null; },
    moveTo(x, y) { this.path = [[x, y]]; },
    lineTo(x, y) { this.path.push([x, y]); },
    closePath() { },
    arc(x, y, r) { this.disc = { x, y, r }; },
    fill() {
      if (this.disc) ops.push({ op: 'cap', colour: fill, ...this.disc });
      else ops.push({ op: 'piece', colour: fill, points: this.path.slice() });
    },
    stroke() {
      ops.push({
        op: 'stroke', colour: this.strokeStyle, width: this.lineWidth,
        points: this.path.slice(),
      });
    },
  };
}

function elementStub() {
  const el = { className: '', style: {}, children: [], text: '', parent: null };
  Object.defineProperty(el, 'textContent', {
    get() { return el.text; },
    set(value) {
      el.text = String(value);
      if (el.text === '') el.children.length = 0;
    },
  });
  el.appendChild = (child) => { el.children.push(child); child.parent = el; return child; };
  el.remove = () => {
    if (!el.parent) return;
    const at = el.parent.children.indexOf(el);
    if (at >= 0) el.parent.children.splice(at, 1);
    el.parent = null;
  };
  return el;
}

function load({ width = 1920, height = 1080 } = {}) {
  const ops = [];
  const ctx = recordingContext(ops);
  const body = { dataset: {} };
  const marks = elementStub();
  const on = {};
  const events = {};
  const boxes = [];
  const drags = [];
  let pending = null;

  const sandbox = {
    console: { ...console, log() { } },
    performance, Math, Number, Infinity, parseInt, JSON,
    document: {
      body,
      getElementById: (id) => (id === 'marks' ? marks : { getContext: () => ctx }),
      createElement: () => elementStub(),
    },
    getComputedStyle: () => ({
      getPropertyValue: (name) => VARS[body.dataset.theme || 'default'][name] || '',
    }),
    window: {
      devicePixelRatio: 1.5, innerWidth: width, innerHeight: height,
      addEventListener(type, fn) { (events[type] ||= []).push(fn); },
      api: {
        onTrailCmd: (fn) => { on.cmd = fn; },
        onTrailPoint: (fn) => { on.point = fn; },
        trailDrag: (phase) => drags.push(phase),
        trailBox: (box) => boxes.push(box),
      },
    },
    requestAnimationFrame: (fn) => { pending = fn; return 1; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'renderer', 'trail.js'), 'utf8'),
    sandbox, { filename: 'trail.js' });

  const of = (op) => ops.filter((entry) => entry.op === op);
  return {
    ops,
    pieces: () => of('piece'),
    strokes: () => of('stroke'),
    caps: () => of('cap'),
    clears: () => of('clear'),
    start: (theme, length) => on.cmd({ cmd: 'start', theme, length }),
    stop: () => on.cmd({ cmd: 'stop' }),
    move: (x, y) => on.point([x, y]),
    marks: () => marks.children.filter((el) => el.className === 'mark'),
    boxes: () => marks.children.filter((el) => el.className.startsWith('box')),
    sent: () => boxes,
    drags: () => drags,
    arm: (n) => on.cmd({ cmd: 'arm', n }),
    disarm: () => on.cmd({ cmd: 'disarm' }),
    point: (type, x, y) => {
      for (const fn of events[type] || []) fn({ clientX: x, clientY: y, preventDefault() { } });
    },
    drag(x0, y0, x1, y1) {
      this.point('pointerdown', x0, y0);
      this.point('pointermove', x1, y1);
      this.point('pointerup', x1, y1);
    },
    body,
    frame: () => { const fn = pending; pending = null; fn(); },
    forget: () => { ops.length = 0; },
  };
}

const rgb = (colour) => colour.match(/[\d.]+/g).map(Number);
// A piece runs [near + edge, far + edge, far - edge, near - edge], so the two
// ends of its centre line are the midpoints of its first/last and middle pair
// of corners, and its width at each end is how far apart that pair is.
const nearEnd = ({ points: p }) => [(p[0][0] + p[3][0]) / 2, (p[0][1] + p[3][1]) / 2];
const farEnd = ({ points: p }) => [(p[1][0] + p[2][0]) / 2, (p[1][1] + p[2][1]) / 2];
const nearWidth = ({ points: p }) => Math.hypot(p[0][0] - p[3][0], p[0][1] - p[3][1]);
const farWidth = ({ points: p }) => Math.hypot(p[1][0] - p[2][0], p[1][1] - p[2][1]);
const pieceLength = (piece) => {
  const a = nearEnd(piece);
  const b = farEnd(piece);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
};

check('the trail is as long as the setting, not as long as the path walked', () => {
  const t = load();
  t.start('default', 650);
  for (let x = 0; x <= 1200; x += 10) t.move(x, 500);
  t.frame();
  const drawn = t.pieces().reduce((sum, p) => sum + pieceLength(p), 0);
  assert.ok(Math.abs(drawn - 650) <= 20, `drew ${drawn.toFixed(1)}px of a 650px trail`);
});

check('a scribble costs what it drew, measured along the line', () => {
  const t = load();
  t.start('default', 400);
  // Back and forth over the same 100px: a straight-line measure from the
  // cursor would keep all of it, an along-the-line one keeps 400px of it.
  for (let i = 0; i < 200; i++) t.move(300 + (i % 2 ? 100 : 0), 400);
  t.frame();
  const drawn = t.pieces().reduce((sum, p) => sum + pieceLength(p), 0);
  assert.ok(Math.abs(drawn - 400) <= 100, `drew ${drawn.toFixed(1)}px`);
});

// This is the one the ribbon exists for. Two pieces that overlap are
// composited twice, and at half opacity that is three quarters — which is
// what put a bead of light at every joint when the line was stroked a segment
// at a time. Sharing the corners exactly is what makes an overlap impossible.
check('neighbouring pieces share their corners exactly, so nothing overlaps', () => {
  const t = load();
  t.start('default', 650);
  // A curve, so the joints are real corners rather than a straight line where
  // any two ways of computing the edge would agree anyway.
  for (let i = 0; i < 60; i++) {
    t.move(400 + Math.cos(i / 7) * 180, 400 + Math.sin(i / 5) * 160);
  }
  t.frame();
  const pieces = t.pieces();
  assert.ok(pieces.length > 20, `only ${pieces.length} pieces`);
  // Pieces come out head first, so each one's far end is the next one's near
  // end, corner for corner.
  for (let i = 0; i < pieces.length - 1; i++) {
    assert.deepStrictEqual(
      [pieces[i].points[1], pieces[i].points[2]],
      [pieces[i + 1].points[0], pieces[i + 1].points[3]],
      `piece ${i} and ${i + 1} do not meet on the same two corners`);
  }
});

check('a corner keeps the line’s width rather than pinching it', () => {
  const t = load();
  t.start('default', 650);
  // A right angle, which is where an unmitred join would lose the most.
  for (let i = 0; i < 20; i++) t.move(200 + i * 10, 300);
  for (let i = 1; i < 20; i++) t.move(400, 300 + i * 10);
  t.frame();
  const pieces = t.pieces();
  const widths = pieces.map(nearWidth);
  // Every piece is between the tail width and the mitre limit's worth of the
  // head width; nothing collapses and nothing spikes.
  assert.ok(Math.min(...widths) > 0.5, `narrowest was ${Math.min(...widths).toFixed(2)}px`);
  assert.ok(Math.max(...widths) <= 4.5 * 2 + 0.01, `widest was ${Math.max(...widths).toFixed(2)}px`);
});

check('the head is at the cursor, in the scheme’s bright colour', () => {
  const t = load();
  t.start('default', 650);
  for (let x = 0; x <= 800; x += 10) t.move(x, 500);
  t.frame();
  const first = t.pieces()[0];
  const [x, y] = nearEnd(first);
  assert.ok(Math.abs(x - 800) < 1e-6 && Math.abs(y - 500) < 1e-6, `head was at ${x},${y}`);
  const [r, g, b] = rgb(first.colour);
  assert.ok(Math.abs(r - 240) <= 4 && Math.abs(g - 168) <= 4 && Math.abs(b - 120) <= 4,
    `head was ${first.colour}, expected --bar-top #f0a878`);
});

check('the cursor end is rounded off rather than cut square', () => {
  const t = load();
  t.start('default', 650);
  for (let x = 0; x <= 800; x += 10) t.move(x, 500);
  t.frame();
  const caps = t.caps();
  assert.strictEqual(caps.length, 1);
  assert.deepStrictEqual([caps[0].x, caps[0].y], [800, 500]);
  assert.strictEqual(caps[0].r * 2, 4.5);
  // Drawn last, so it is the piece behind it that it covers and not the other
  // way round.
  assert.strictEqual(t.ops[t.ops.length - 1].op, 'cap');
});

check('the tail is the scheme’s darker colour, faded out and thin', () => {
  const t = load();
  t.start('default', 650);
  for (let x = 0; x <= 800; x += 10) t.move(x, 500);
  t.frame();
  const pieces = t.pieces();
  const last = pieces[pieces.length - 1];
  const [r, g, b, a] = rgb(last.colour);
  assert.ok(Math.abs(r - 216) <= 4 && Math.abs(g - 130) <= 4 && Math.abs(b - 90) <= 4,
    `tail was ${last.colour}, expected --bar-bottom #d8825a`);
  assert.ok(a < 0.05, `tail alpha was ${a}`);
  assert.ok(farWidth(last) < nearWidth(pieces[0]), 'the line should taper toward the tail');
});

check('the width changes continuously, without a step between pieces', () => {
  const t = load();
  t.start('default', 650);
  for (let x = 0; x <= 800; x += 10) t.move(x, 500);
  t.frame();
  const pieces = t.pieces();
  for (let i = 0; i < pieces.length - 1; i++) {
    assert.ok(Math.abs(farWidth(pieces[i]) - nearWidth(pieces[i + 1])) < 1e-6,
      `piece ${i} ends at a different width than piece ${i + 1} begins`);
  }
});

check('the synthwave scheme adds one glow pass over the whole line', () => {
  const t = load();
  t.start('synthwave', 400);
  for (let i = 0; i < 40; i++) t.move(100 + i * 8, 200 + i * 3);
  t.frame();
  const strokes = t.strokes();
  assert.strictEqual(strokes.length, 1, 'the glow should be one pass, not one per piece');
  assert.ok(strokes[0].points.length > 10);
  const [r, g, b] = rgb(t.pieces()[0].colour);
  assert.ok(Math.abs(r - 34) <= 8 && Math.abs(g - 224) <= 8 && Math.abs(b - 255) <= 8,
    `head was ${t.pieces()[0].colour}, expected --bar-top #22e0ff`);
});

check('the default scheme has no glow, so the line is only filled', () => {
  const t = load();
  t.start('default', 400);
  for (let i = 0; i < 40; i++) t.move(100 + i * 8, 200);
  t.frame();
  assert.strictEqual(t.strokes().length, 0);
  assert.ok(t.pieces().every((p) => p.points.length === 4));
});

check('only the painted region is cleared, not the whole monitor', () => {
  const t = load({ width: 3840, height: 2160 });
  t.start('default', 650);
  for (let x = 0; x <= 400; x += 10) t.move(x, 500);
  t.frame();
  t.forget();
  t.frame();
  const clears = t.clears();
  assert.strictEqual(clears.length, 1);
  assert.ok(clears[0].w < 600 && clears[0].h < 200,
    `cleared ${clears[0].w}x${clears[0].h}`);
});

check('stopping fades the line out rather than cutting it', () => {
  const t = load();
  t.start('default', 650);
  for (let i = 0; i < 40; i++) t.move(i * 10, 300);
  t.frame();
  const solid = rgb(t.pieces()[0].colour)[3];
  t.stop();
  const until = Date.now() + 80;
  while (Date.now() < until) { /* spin: the fade is measured against the clock */ }
  t.forget();
  t.frame();
  assert.ok(t.pieces().length > 0, 'the line should still be drawn while it fades');
  assert.ok(rgb(t.pieces()[0].colour)[3] < solid, 'the fade should dim it');
});

check('the fade finishes, and then there is nothing left to draw or clear', () => {
  const t = load();
  t.start('default', 650);
  for (let i = 0; i < 40; i++) t.move(i * 10, 300);
  t.frame();
  t.stop();
  // FADE_MS in trail.js is 420; main hides the window at 500.
  const until = Date.now() + 550;
  while (Date.now() < until) { /* spin: the fade is measured against the clock */ }
  t.forget();
  t.frame();
  assert.strictEqual(t.pieces().length, 0);
  t.forget();
  t.frame();
  assert.strictEqual(t.ops.length, 0, 'a cleared canvas should not be cleared again');
});

check('a point after the fade begins starts the next trail, not the old one', () => {
  const t = load();
  t.start('default', 650);
  for (let i = 0; i < 40; i++) t.move(i * 10, 300);
  t.frame();
  t.stop();
  t.move(900, 900);
  t.move(950, 900);
  t.forget();
  t.frame();
  const pieces = t.pieces();
  assert.strictEqual(pieces.length, 1);
  assert.deepStrictEqual(nearEnd(pieces[0]), [950, 900]);
  // Not 1.0: the piece's colour is taken at its middle, already a little way
  // back along a 650px trail.
  assert.ok(rgb(pieces[0].colour)[3] > 0.8, 'the new line should be at full strength');
});

check('sub-pixel movement does not become a piece each', () => {
  const t = load();
  t.start('default', 650);
  for (let i = 0; i < 500; i++) t.move(100 + i * 0.2, 100);
  t.frame();
  assert.ok(t.pieces().length < 80, `${t.pieces().length} pieces for 100px of travel`);
});

check('a single point draws nothing', () => {
  const t = load();
  t.start('default', 650);
  t.move(500, 500);
  t.frame();
  assert.strictEqual(t.pieces().length, 0);
  assert.strictEqual(t.caps().length, 0);
});

check('a number that would fall off the edge is pulled back inside it', () => {
  const t = load({ width: 800, height: 600 });
  t.start('default', 650);
  t.arm(7);
  t.drag(2, 2, 200, 200);
  const [mark] = t.marks();
  assert.strictEqual(mark.style.left, '16px');
  assert.strictEqual(mark.style.top, '16px');
});

check('the numbers count up and stay up while the recording runs', () => {
  const t = load();
  t.start('default', 650);
  for (const n of [1, 2, 3]) {
    t.arm(n);
    t.drag(n * 100, n * 100, n * 100 + 80, n * 100 + 80);
  }
  assert.deepStrictEqual(t.marks().map((m) => m.textContent), ['1', '2', '3']);
  assert.strictEqual(t.boxes().length, 3);
});

check('the next dictation starts from a clear screen', () => {
  const t = load();
  t.start('default', 650);
  t.arm(1);
  t.drag(100, 100, 300, 300);
  t.stop();
  assert.strictEqual(t.body.dataset.fading, 'yes');
  t.start('default', 650);
  assert.strictEqual(t.marks().length, 0);
  assert.strictEqual(t.boxes().length, 0);
  assert.strictEqual(t.body.dataset.fading, undefined);
});

check('an armed window shows the crosshair and the number it is waiting for', () => {
  const t = load();
  t.start('default', 650);
  t.arm(4);
  assert.strictEqual(t.body.dataset.armed, '4');
  t.disarm();
  assert.strictEqual(t.body.dataset.armed, undefined);
});

check('a drag draws the box and puts the number above its top-left corner', () => {
  const t = load();
  t.start('default', 650);
  t.arm(1);
  t.drag(600, 400, 300, 200);
  const [box] = t.boxes();
  assert.strictEqual(box.className, 'box');
  assert.strictEqual(box.style.left, '300px');
  assert.strictEqual(box.style.top, '200px');
  assert.strictEqual(box.style.width, '300px');
  assert.strictEqual(box.style.height, '200px');
  const [mark] = t.marks();
  assert.strictEqual(mark.textContent, '1');
  assert.strictEqual(mark.style.left, '313px');
  assert.strictEqual(mark.style.top, '187px');
  assert.strictEqual(t.sent().length, 1);
  assert.deepStrictEqual({ ...t.sent()[0] }, { n: 1, x: 300, y: 200, w: 300, h: 200 });
});

check('the drag is reported the moment it starts, not only when it ends', () => {
  const t = load();
  t.start('default', 650);
  t.arm(1);
  t.point('pointerdown', 100, 100);
  assert.deepStrictEqual(t.drags(), ['start']);
  assert.strictEqual(t.sent().length, 0);
  t.point('pointerup', 300, 300);
  assert.strictEqual(t.sent().length, 1);
});

check('a drag on a window that was not armed reports nothing', () => {
  const t = load();
  t.start('default', 650);
  t.point('pointerdown', 100, 100);
  assert.deepStrictEqual(t.drags(), []);
});

check('the box follows the pointer while it is being drawn', () => {
  const t = load();
  t.start('default', 650);
  t.arm(1);
  t.point('pointerdown', 100, 100);
  t.point('pointermove', 180, 160);
  const [box] = t.boxes();
  assert.strictEqual(box.className, 'box drawing');
  assert.strictEqual(box.style.width, '80px');
  assert.strictEqual(box.style.height, '60px');
  assert.strictEqual(t.marks().length, 0);
});

check('a click with no rectangle draws nothing and keeps the crosshair', () => {
  const t = load();
  t.start('default', 650);
  t.arm(2);
  t.drag(500, 500, 502, 501);
  assert.strictEqual(t.boxes().length, 0);
  assert.strictEqual(t.marks().length, 0);
  assert.strictEqual(t.sent().length, 0);
  assert.deepStrictEqual(t.drags(), ['start', 'cancel']);
  assert.strictEqual(t.body.dataset.armed, '2');
});

check('the number offered is only spent on a rectangle that was drawn', () => {
  const t = load();
  t.start('default', 650);
  t.arm(2);
  t.drag(500, 500, 501, 500);
  t.drag(400, 400, 600, 550);
  assert.strictEqual(t.boxes().length, 1);
  assert.deepStrictEqual(t.marks().map((m) => m.textContent), ['2']);
});

check('a window that was not armed draws nothing when dragged', () => {
  const t = load();
  t.start('default', 650);
  t.drag(100, 100, 400, 400);
  assert.strictEqual(t.boxes().length, 0);
  assert.strictEqual(t.marks().length, 0);
  assert.strictEqual(t.sent().length, 0);
});

check('a cancelled pointer is not a released rectangle', () => {
  const t = load();
  t.start('default', 650);
  t.arm(5);
  t.point('pointerdown', 100, 100);
  t.point('pointermove', 400, 400);
  t.point('pointercancel', 400, 400);
  assert.strictEqual(t.boxes().length, 0);
  assert.strictEqual(t.marks().length, 0);
  assert.strictEqual(t.sent().length, 0);
  assert.deepStrictEqual(t.drags(), ['start', 'cancel']);
  assert.strictEqual(t.body.dataset.armed, '5');
});

check('disarming mid-drag takes the half-drawn box away', () => {
  const t = load();
  t.start('default', 650);
  t.arm(3);
  t.point('pointerdown', 100, 100);
  t.point('pointermove', 300, 300);
  assert.strictEqual(t.boxes().length, 1);
  t.disarm();
  assert.strictEqual(t.boxes().length, 0);
  assert.strictEqual(t.marks().length, 0);
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
