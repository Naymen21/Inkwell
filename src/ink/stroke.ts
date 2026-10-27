// Ink math: filtering raw samples, pressure/velocity width, simplification for
// storage, Catmull-Rom interpolation and the filled outline used for drawing.
// Pure functions except buildPath, which only needs a Path2D-like sink.

export interface Sample { x: number; y: number; p: number; t: number }
export interface InkPoint { x: number; y: number; w: number }

export interface InkStyle {
  width: number;
  /** false = constant width (highlighter, or pressure turned off). */
  pressure: boolean;
}

/**
 * Streaming filter: exponential smoothing on position whose strength drops as
 * the pen speeds up (one-euro style), so slow writing is steady and fast
 * strokes don't lag behind the tip.
 */
export class InkFilter {
  pts: InkPoint[] = [];
  private sx = 0; private sy = 0; private sw = 0;
  private lastT = 0; private speed = 0; private n = 0;

  constructor(private style: InkStyle) {}

  push(s: Sample): InkPoint | null {
    if (this.n === 0) {
      this.sx = s.x; this.sy = s.y; this.lastT = s.t;
      this.sw = this.width(s.p, 0);
      this.n++;
      const p = { x: s.x, y: s.y, w: this.sw };
      this.pts.push(p);
      return p;
    }
    const dt = Math.max(1, s.t - this.lastT);
    const d = Math.hypot(s.x - this.sx, s.y - this.sy);
    if (d < 0.25) return null;
    this.speed = this.speed * 0.6 + (d / dt) * 0.4;
    const a = Math.min(1, 0.55 + this.speed * 0.45);
    this.sx += (s.x - this.sx) * a;
    this.sy += (s.y - this.sy) * a;
    this.sw += (this.width(s.p, this.speed) - this.sw) * 0.35;
    this.lastT = s.t;
    this.n++;
    const p = { x: this.sx, y: this.sy, w: this.sw };
    this.pts.push(p);
    return p;
  }

  /** Width for a sample. Thicker with force, thinner when moving fast (ballpoint feel). */
  width(pressure: number, speed: number): number {
    const b = this.style.width;
    if (!this.style.pressure) return b;
    const p = pressure > 0 ? pressure : 0.5;
    const v = Math.min(1, Math.max(0.55, 1 - speed * 0.12));
    return b * (0.45 + 0.75 * p) * v;
  }

  /** Close the stroke at the raw end point so the ink reaches where the pen lifted. */
  finish(last?: Sample): InkPoint[] {
    if (last && this.pts.length) {
      const tail = this.pts[this.pts.length - 1];
      if (Math.hypot(last.x - tail.x, last.y - tail.y) > 0.5) this.pts.push({ x: last.x, y: last.y, w: tail.w });
    }
    return this.pts;
  }
}

/** Ramer–Douglas–Peucker over (x, y, w): keeps width changes, drops redundant points. */
export function simplify(pts: InkPoint[], eps = 0.18): InkPoint[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = pts[i0], b = pts[i1];
    let best = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i];
      const t = segT(p, a, b);
      const cx = a.x + (b.x - a.x) * t - p.x;
      const cy = a.y + (b.y - a.y) * t - p.y;
      const cw = (a.w + (b.w - a.w) * t - p.w) * 0.5;
      const d = cx * cx + cy * cy + cw * cw;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps2) {
      keep[bi] = 1;
      stack.push([i0, bi], [bi, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segT(p: InkPoint, a: InkPoint, b: InkPoint) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  if (!l) return 0;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function toFlat(pts: InkPoint[]): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(round2(p.x), round2(p.y), round2(p.w));
  return out;
}

export function fromFlat(flat: number[]): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i < flat.length; i += 3) out.push({ x: flat[i], y: flat[i + 1], w: flat[i + 2] });
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Interpolate a Catmull-Rom spline through the control points (sampled ~1.5pt apart). */
export function spline(pts: InkPoint[]): InkPoint[] {
  if (pts.length < 3) return pts.slice();
  const out: InkPoint[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const steps = Math.min(24, Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 1.5)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y), w: p1.w + (p2.w - p1.w) * t });
    }
  }
  return out;
}

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  closePath(): void;
}

/**
 * Emit the variable-width ribbon as a union of convex pieces: one quad per
 * segment plus a round disc at each end and wherever the path turns. Every
 * piece has the same (positive) winding, so under the nonzero rule overlaps
 * always add up and never cancel — no holes on fast, sharp strokes, and one
 * fill means translucent ink (highlighter) never doubles up.
 */
export function buildPath(sink: PathSink, input: InkPoint[]) {
  const P = input.length > 2 ? spline(input) : input;
  const n = P.length;
  if (!n) return;
  const r = (i: number) => Math.max(0.3, P[i].w / 2);
  disc(sink, P[0].x, P[0].y, r(0));
  let pdx = 0, pdy = 0;
  for (let i = 1; i < n; i++) {
    const a = P[i - 1], b = P[i];
    let dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) continue;
    dx /= l; dy /= l;
    // Round join where the direction changes enough to open a wedge on the outside.
    if ((pdx || pdy) && dx * pdx + dy * pdy < 0.995) disc(sink, a.x, a.y, r(i - 1));
    pdx = dx; pdy = dy;
    const nx = -dy, ny = dx, r0 = r(i - 1), r1 = r(i);
    sink.moveTo(a.x - nx * r0, a.y - ny * r0);
    sink.lineTo(b.x - nx * r1, b.y - ny * r1);
    sink.lineTo(b.x + nx * r1, b.y + ny * r1);
    sink.lineTo(a.x + nx * r0, a.y + ny * r0);
    sink.closePath();
  }
  if (n > 1) disc(sink, P[n - 1].x, P[n - 1].y, r(n - 1));
}

/** Smoothed centerline only — for constant-width ink drawn with a native round-capped stroke. */
export function buildCenterline(sink: PathSink, input: InkPoint[]) {
  const P = input.length > 2 ? spline(input) : input;
  if (!P.length) return;
  sink.moveTo(P[0].x, P[0].y);
  // A lone point still needs a segment for the round cap to draw a dot.
  if (P.length === 1) sink.lineTo(P[0].x + 0.01, P[0].y);
  for (let i = 1; i < P.length; i++) sink.lineTo(P[i].x, P[i].y);
}

function disc(sink: PathSink, x: number, y: number, r: number) {
  sink.moveTo(x + r, y);
  sink.arc(x, y, r, 0, Math.PI * 2);
  sink.closePath();
}

/** If a stroke is nearly straight, return it as an exact line (highlighter lock). */
export function straighten(pts: InkPoint[], snapAxis = true): InkPoint[] | null {
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 24) return null;
  let maxD = 0;
  for (const p of pts) maxD = Math.max(maxD, Math.sqrt(distSq(p, a, b)));
  if (maxD > Math.max(3, len * 0.04)) return null;
  let ex = b.x, ey = b.y;
  if (snapAxis) {
    const ang = Math.abs(Math.atan2(b.y - a.y, b.x - a.x));
    if (ang < 0.09 || Math.PI - ang < 0.09) ey = a.y;
    else if (Math.abs(ang - Math.PI / 2) < 0.09) ex = a.x;
  }
  const w = pts.reduce((s, p) => s + p.w, 0) / pts.length;
  return [{ x: a.x, y: a.y, w }, { x: ex, y: ey, w }];
}

function distSq(p: InkPoint, a: InkPoint, b: InkPoint) {
  const t = segT(p, a, b);
  const cx = a.x + (b.x - a.x) * t - p.x, cy = a.y + (b.y - a.y) * t - p.y;
  return cx * cx + cy * cy;
}

/** Resample to at most `step` spacing (linear) – used before splitting/erasing. */
export function densify(pts: InkPoint[], step = 1.5): InkPoint[] {
  if (pts.length < 2) return pts.slice();
  const out: InkPoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t });
    }
  }
  return out;
}
