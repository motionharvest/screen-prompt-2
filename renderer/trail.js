// Cursor trail renderer: one of these runs per monitor while you are
// dictating, in a transparent click-through window the size of that monitor.
//
// It knows nothing about recording and nothing about the microphone. Main
// reads the cursor and sends a point; this draws the last so many pixels of
// where those points have been, in the same colours the pill's spectrum uses,
// and forgets the rest. Coordinates arrive already local to this window, in
// the DIP space that CSS pixels are measured in, so nothing here converts
// between one screen's scale factor and another's.

const canvas = document.getElementById('trail');
const ctx = canvas.getContext('2d');
const marks = document.getElementById('marks');

// The line's shape. Width tapers from the cursor back to nothing, and the
// alpha curve is steeper than linear so the tail thins out rather than ending
// on a visible stub.
const HEAD_WIDTH = 4.5;
const TAIL_WIDTH = 0.8;
const FADE_POWER = 1.5;
// How far a corner may push its outer edge out, as a multiple of the half
// width, before the join is allowed to narrow instead. Without a limit a hairpin
// turn sends the mitre off to infinity; with one, the worst a sharp corner does
// is lose a fraction of a pixel of width.
const MITRE_LIMIT = 2;
// Points closer together than this are the same point as far as a drawn line
// is concerned, and keeping them only costs a segment. The cap is the other
// end of the same argument: a very slow drag over a long trail would otherwise
// accumulate thousands of points a pixel apart.
const MIN_STEP = 1.5;
const MAX_POINTS = 600;
// How long the trail takes to disappear once the recording ends. It is faded
// out rather than cleared because the line is on top of whatever you were
// doing, and something that large vanishing between two frames reads as a
// glitch. Main hides the window after this has elapsed — the two have to stay
// in step, and it is stated there as TRAIL_FADE_MS.
const FADE_MS = 420;
const MARK_EDGE = 16;
const MARK_CORNER = 13;
const MIN_BOX = 8;

// Defaults, in case a point arrives before the first configuration does. They
// are the default scheme's, so a trail that draws a frame early draws it in
// the wrong brightness rather than not at all.
let head = { r: 240, g: 168, b: 120 };
let tail = { r: 216, g: 130, b: 90 };
let glow = '';
let maxLength = 650;

let points = [];        // {x, y, d} — d is the distance from the previous one
let fadeStart = 0;      // performance.now() when the fade began, 0 while live
let armedNumber = null;
let drag = null;

// Working room for the geometry, allocated once. The line is rebuilt from
// scratch sixty times a second and these are everything it needs to do that,
// so making them per frame would be the only garbage this file produces.
const behind = new Float32Array(MAX_POINTS);  // path distance back to the cursor
const segNX = new Float32Array(MAX_POINTS);   // unit normal of the segment
const segNY = new Float32Array(MAX_POINTS);   // that starts at this point
const edgeX = new Float32Array(MAX_POINTS);   // where this point's two segments
const edgeY = new Float32Array(MAX_POINTS);   // agree the edge should run
let animId = null;
// What was painted last frame, so the next one clears that rectangle instead
// of the whole monitor. Clearing four megapixels sixty times a second is the
// one thing in here that would show up on a power meter.
let painted = null;

// Canvas backing store in device pixels, drawing commands in CSS pixels. The
// two differ by the monitor's scale factor, and a trail drawn at 100% on a
// 150% screen is a visibly soft line.
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  painted = null;
}

// Colours come from theme.css, the same custom properties the pill's spectrum
// reads, so a scheme is described in one place. Canvas is used as the parser:
// assigning any CSS colour to fillStyle and reading it back gives '#rrggbb' or
// 'rgba(r, g, b, a)', whichever the value was written as.
function parseColor(value) {
  ctx.fillStyle = '#000';
  ctx.fillStyle = value;
  const normal = ctx.fillStyle;
  if (normal[0] === '#') {
    return {
      r: parseInt(normal.slice(1, 3), 16),
      g: parseInt(normal.slice(3, 5), 16),
      b: parseInt(normal.slice(5, 7), 16),
    };
  }
  const [r, g, b] = normal.match(/[\d.]+/g).map(Number);
  return { r, g, b };
}

function applyTheme(theme) {
  document.body.dataset.theme = theme || 'default';
  const css = getComputedStyle(document.body);
  const read = (name) => css.getPropertyValue(name).trim();
  head = parseColor(read('--bar-top'));
  tail = parseColor(read('--bar-bottom'));
  const g = read('--bar-glow');
  glow = g && g !== 'none' ? g : '';
}

// Drop whatever now hangs further than maxLength behind the cursor. Measured
// along the line rather than in a straight line to the cursor, so a loop or a
// scribble costs what it actually drew — which is what makes the trail a fixed
// length of ink rather than a fixed radius around the pointer.
function trim() {
  let total = 0;
  let keepFrom = 0;
  for (let i = points.length - 1; i > 0; i--) {
    total += points[i].d;
    if (total > maxLength) { keepFrom = i; break; }
  }
  if (keepFrom) points = points.slice(keepFrom);
  if (points.length > MAX_POINTS) points = points.slice(points.length - MAX_POINTS);
}

function addPoint(x, y) {
  // A point arriving after the fade began is the start of the next trail, not
  // the continuation of the one that is dying.
  if (fadeStart) reset();
  const last = points[points.length - 1];
  if (!last) { points.push({ x, y, d: 0 }); return; }
  const d = Math.hypot(x - last.x, y - last.y);
  if (d < MIN_STEP) return;
  points.push({ x, y, d });
  trim();
}

function reset() {
  points = [];
  fadeStart = 0;
}

function clearMarks() {
  marks.textContent = '';
}

function placeBadge(x, y, n) {
  const el = document.createElement('div');
  el.className = 'mark';
  el.textContent = String(n);
  const w = window.innerWidth;
  const h = window.innerHeight;
  el.style.left = `${Math.min(Math.max(x, MARK_EDGE), w - MARK_EDGE)}px`;
  el.style.top = `${Math.min(Math.max(y, MARK_EDGE), h - MARK_EDGE)}px`;
  marks.appendChild(el);
  return el;
}

function addBoxMark(x, y, n) {
  return placeBadge(x + MARK_CORNER, y - MARK_CORNER, n);
}

function setArmed(n) {
  armedNumber = n;
  if (n === null) delete document.body.dataset.armed;
  else document.body.dataset.armed = String(n);
}

function boxRect(x0, y0, x1, y1) {
  return {
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
  };
}

function sizeBox(el, rect) {
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
}

function cancelDrag() {
  if (!drag) return;
  try { document.body.releasePointerCapture?.(drag.pointerId); } catch { /* already gone */ }
  drag.el.remove();
  drag = null;
}

// The rectangle the current line occupies, padded for the stroke width and the
// blur around it. Returned in CSS pixels, which is what clearRect is given.
function extent() {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = HEAD_WIDTH + (glow ? 14 : 2);
  return {
    x: minX - pad, y: minY - pad,
    w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2,
  };
}

// Everything the line's shape depends on, worked out once per frame for the
// points that are currently in hand: how far back from the cursor each one
// sits, and which way the edge of the ribbon runs as it passes through it.
//
// The edge direction at a point is the average of the normals of the two
// segments meeting there, lengthened by the mitre so the ribbon keeps its
// width around a corner instead of pinching. Both segments then read the same
// two numbers for the vertices they share, which is the whole point of
// computing it here rather than per segment: the pieces line up exactly.
function buildEdges(n) {
  behind[n - 1] = 0;
  for (let i = n - 2; i >= 0; i--) behind[i] = behind[i + 1] + points[i + 1].d;

  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const len = Math.hypot(dx, dy) || 1;
    segNX[i] = -dy / len;
    segNY[i] = dx / len;
  }

  for (let i = 0; i < n; i++) {
    // The ends have one segment each, so they take its normal unchanged.
    const before = i === 0 ? 0 : i - 1;
    const after = i === n - 1 ? n - 2 : i;
    let ex = segNX[before] + segNX[after];
    let ey = segNY[before] + segNY[after];
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) {
      // A fold back on itself: the two normals cancel, and there is no
      // average to take. The outgoing segment's own normal is the honest
      // answer, and the fold is a point rather than a corner anyway.
      ex = segNX[after];
      ey = segNY[after];
    } else {
      ex /= len;
      ey /= len;
      // 1 / cos(half the turn) is how much further out the outer edge has to
      // go to keep the width, and it is the dot product of the averaged
      // normal with either segment's.
      const cos = ex * segNX[after] + ey * segNY[after];
      const mitre = Math.min(MITRE_LIMIT, 1 / Math.max(1 / MITRE_LIMIT, cos));
      ex *= mitre;
      ey *= mitre;
    }
    edgeX[i] = ex;
    edgeY[i] = ey;
  }
}

// Half the line's width where the given point sits, which is what the edge is
// offset by on each side.
function halfWidth(i) {
  const k = 1 - Math.min(1, behind[i] / maxLength);
  return (TAIL_WIDTH + (HEAD_WIDTH - TAIL_WIDTH) * k) / 2;
}

function draw() {
  animId = requestAnimationFrame(draw);

  if (painted) {
    ctx.clearRect(painted.x, painted.y, painted.w, painted.h);
    painted = null;
  }

  let alpha = 1;
  if (fadeStart) {
    alpha = 1 - (performance.now() - fadeStart) / FADE_MS;
    if (alpha <= 0) { reset(); return; }
  }
  if (points.length < 2) return;

  const box = extent();

  // One pass for the glow, because a shadow is drawn once per shape and the
  // ribbon below is forty of them. Stroking the whole path faintly and letting
  // the blur do the work costs one.
  if (glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 12;
    ctx.globalAlpha = alpha * 0.5;
    ctx.strokeStyle = glow;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.restore();
  }

  // Then the line itself, as a ribbon: one four-sided piece per segment,
  // filled rather than stroked, each piece sharing its two end corners with
  // the piece next to it.
  //
  // It was a stroked line per segment, and that is what put a bead of light at
  // every joint. Two strokes that overlap are composited twice, and at half
  // opacity twice is three quarters rather than a half, so every place two
  // round caps sat on top of each other came out half again as bright as the
  // line they were joining — a string of dots along the path. Pieces that meet
  // along a shared edge cannot overlap, so there is nothing to composite twice
  // and the joints disappear. It is also what allows the width to change
  // continuously along the line instead of in a step per segment.
  //
  // `t` is how far back from the cursor a piece sits, as a fraction of the
  // trail's length: 0 at the cursor, 1 at the far end. The colours are the
  // spectrum's two — the bright one at the head, where the spectrum puts it in
  // the middle of the pill, shading to the darker one as the line runs out.
  const n = points.length;
  buildEdges(n);

  for (let i = n - 2; i >= 0; i--) {
    const near = points[i + 1];
    const far = points[i];
    const t = Math.min(1, (behind[i] + behind[i + 1]) / 2 / maxLength);
    const fade = Math.pow(1 - t, FADE_POWER);
    const r = Math.round(head.r + (tail.r - head.r) * t);
    const g = Math.round(head.g + (tail.g - head.g) * t);
    const b = Math.round(head.b + (tail.b - head.b) * t);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(fade * alpha).toFixed(3)})`;

    const hn = halfWidth(i + 1);
    const hf = halfWidth(i);
    ctx.beginPath();
    ctx.moveTo(near.x + edgeX[i + 1] * hn, near.y + edgeY[i + 1] * hn);
    ctx.lineTo(far.x + edgeX[i] * hf, far.y + edgeY[i] * hf);
    ctx.lineTo(far.x - edgeX[i] * hf, far.y - edgeY[i] * hf);
    ctx.lineTo(near.x - edgeX[i + 1] * hn, near.y - edgeY[i + 1] * hn);
    ctx.closePath();
    ctx.fill();
  }

  // The cursor end would otherwise be cut off square. This one disc may
  // overlap the piece behind it, and is the one place that does not matter:
  // at the head the line is as close to opaque as it gets, and compositing
  // something opaque twice looks exactly like compositing it once.
  const tip = points[n - 1];
  ctx.fillStyle = `rgba(${head.r}, ${head.g}, ${head.b}, ${alpha.toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, HEAD_WIDTH / 2, 0, Math.PI * 2);
  ctx.fill();

  painted = box;
}

// The loop runs for as long as the window is shown, which is only for as long
// as a dictation plus the fade. Main hides the window rather than asking this
// to stop, and a hidden window's frames stop arriving on their own.
function start() {
  if (animId === null) animId = requestAnimationFrame(draw);
}

window.addEventListener('resize', resize);
resize();
start();

window.api.onTrailCmd((cmd) => {
  if (cmd.theme !== undefined) applyTheme(cmd.theme);
  if (Number.isFinite(cmd.length)) maxLength = cmd.length;
  if (cmd.cmd === 'start') {
    reset();
    cancelDrag();
    setArmed(null);
    clearMarks();
    delete document.body.dataset.fading;
  }
  if (cmd.cmd === 'arm') setArmed(cmd.n);
  if (cmd.cmd === 'disarm') {
    cancelDrag();
    setArmed(null);
  }
  // Stop feeding it and let it go out, rather than cutting a line that covers
  // the screen between one frame and the next.
  if (cmd.cmd === 'stop' && !fadeStart) {
    fadeStart = performance.now();
    document.body.dataset.fading = 'yes';
  }
});

window.api.onTrailPoint(([x, y]) => addPoint(x, y));

window.addEventListener('pointerdown', (e) => {
  console.log(`pointerdown armed=${armedNumber} drag=${Boolean(drag)}`);
  if (armedNumber === null || drag) return;
  const el = document.createElement('div');
  el.className = 'box drawing';
  marks.appendChild(el);
  drag = { x: e.clientX, y: e.clientY, el, pointerId: e.pointerId };
  sizeBox(el, boxRect(drag.x, drag.y, e.clientX, e.clientY));
  try { document.body.setPointerCapture?.(e.pointerId); } catch { /* not captured */ }
  window.api.trailDrag('start');
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  sizeBox(drag.el, boxRect(drag.x, drag.y, e.clientX, e.clientY));
});

window.addEventListener('pointerup', (e) => {
  if (!drag) {
    console.log(`pointerup with no drag armed=${armedNumber}`);
    return;
  }
  const { x, y, el, pointerId } = drag;
  const n = armedNumber;
  drag = null;
  try { document.body.releasePointerCapture?.(pointerId); } catch { /* already gone */ }
  const rect = boxRect(x, y, e.clientX, e.clientY);
  console.log(`pointerup ${JSON.stringify(rect)} armed=${n}`);
  if (rect.w < MIN_BOX || rect.h < MIN_BOX) {
    el.remove();
    window.api.trailDrag('cancel');
    return;
  }
  setArmed(null);
  el.className = 'box';
  addBoxMark(rect.x, rect.y, n);
  window.api.trailBox({ n, ...rect });
});

window.addEventListener('pointercancel', () => {
  if (!drag) return;
  console.log('pointercancel mid-drag');
  cancelDrag();
  window.api.trailDrag('cancel');
});

applyTheme('default');
