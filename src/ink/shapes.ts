// Shape recognition: rough stroke in, ideal geometry out (as an ink polyline,
// so shapes stay ordinary vector strokes that erase/recolor like any ink).
import type { Pt } from '../util/geom';

export type ShapeKind = 'line' | 'triangle' | 'rectangle' | 'polygon' | 'ellipse';
export interface Shape { kind: ShapeKind; pts: Pt[] }

export function recognizeShape(raw: Pt[]): Shape | null {
  if (raw.length < 3) return null;
  const len = polyLen(raw);
  if (len < 20) return null;
  const a = raw[0], b = raw[raw.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);

  // Line: everything hugs the chord.
  let maxDev = 0;
  for (const p of raw) maxDev = Math.max(maxDev, distToLine(p, a, b));
  if (chord > 0.85 * len && maxDev < Math.max(4, chord * 0.07)) return { kind: 'line', pts: [a, b] };

  const closed = chord < Math.max(24, len * 0.18);
  if (!closed) return null;

  // Corners via RDP on the closed loop.
  const loop = [...raw, raw[0]];
  const box = bounds(raw);
  const diag = Math.hypot(box.w, box.h);
  let corners = rdp(loop, diag * 0.08);
  corners = corners.slice(0, -1); // drop duplicate closing point
  corners = mergeClose(corners, diag * 0.12);

  const ell = fitEllipse(raw);
  if (corners.length >= 3 && corners.length <= 6) {
    const polyErr = meanDistToPolygon(raw, corners) / diag;
    if (polyErr < 0.035 && (ell.err > 0.07 || corners.length <= 4 && polyErr < ell.err * 0.6)) {
      if (corners.length === 3) return { kind: 'triangle', pts: closeLoop(corners) };
      if (corners.length === 4) return { kind: 'rectangle', pts: closeLoop(squareUp(corners)) };
      return { kind: 'polygon', pts: closeLoop(corners) };
    }
  }
  if (ell.err < 0.14) {
    const pts: Pt[] = [];
    const N = 72;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2;
      const ex = ell.rx * Math.cos(t), ey = ell.ry * Math.sin(t);
      pts.push({
        x: ell.cx + ex * Math.cos(ell.rot) - ey * Math.sin(ell.rot),
        y: ell.cy + ex * Math.sin(ell.rot) + ey * Math.cos(ell.rot),
      });
    }
    return { kind: 'ellipse', pts };
  }
  return null;
}

function closeLoop(p: Pt[]) { return [...p, p[0]]; }

/** If a quad is roughly rectangular, make it an exact (possibly rotated) rectangle. */
function squareUp(q: Pt[]): Pt[] {
  const angles = q.map((p, i) => {
    const a = q[(i + 3) % 4], b = q[(i + 1) % 4];
    const v1 = { x: a.x - p.x, y: a.y - p.y }, v2 = { x: b.x - p.x, y: b.y - p.y };
    return Math.abs(Math.acos(clamp((v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)), -1, 1)) - Math.PI / 2);
  });
  if (Math.max(...angles) > 0.35) return q;
  let rot = Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x);
  // Snap near-axis-aligned rectangles to axis.
  const snapped = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(rot - snapped) < 0.12) rot = snapped;
  const c = { x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 };
  const cos = Math.cos(rot), sin = Math.sin(rot);
  let hw = 0, hh = 0;
  for (const p of q) {
    const dx = p.x - c.x, dy = p.y - c.y;
    hw += Math.abs(dx * cos + dy * sin);
    hh += Math.abs(-dx * sin + dy * cos);
  }
  hw /= 4; hh /= 4;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
    x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos,
  }));
}

function fitEllipse(pts: Pt[]) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  let rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // Points spread evenly on an ellipse have variance r^2/2 along each axis.
  let rx = Math.sqrt(2 * l1), ry = Math.sqrt(2 * Math.max(0, l2));
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) { rx = ry = (rx + ry) / 2; rot = 0; }
  let err = 0;
  const cos = Math.cos(-rot), sin = Math.sin(-rot);
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    const ex = dx * cos - dy * sin, ey = dx * sin + dy * cos;
    err += Math.abs(Math.sqrt((ex / (rx || 1)) ** 2 + (ey / (ry || 1)) ** 2) - 1);
  }
  return { cx, cy, rx, ry, rot, err: err / pts.length };
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let best = 0, bi = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 ? Math.hypot(pts[i].x - a.x, pts[i].y - a.y) : distToSeg(pts[i], a, b);
    if (d > best) { best = d; bi = i; }
  }
  if (best <= eps) return [a, b];
  return [...rdp(pts.slice(0, bi + 1), eps).slice(0, -1), ...rdp(pts.slice(bi), eps)];
}

function mergeClose(c: Pt[], d: number): Pt[] {
  const out: Pt[] = [];
  for (const p of c) {
    if (out.length && Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) < d) continue;
    out.push(p);
  }
  if (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < d) out.pop();
  return out;
}

function meanDistToPolygon(pts: Pt[], poly: Pt[]) {
  let s = 0;
  for (const p of pts) {
    let m = Infinity;
    for (let i = 0; i < poly.length; i++) m = Math.min(m, distToSeg(p, poly[i], poly[(i + 1) % poly.length]));
    s += m;
  }
  return s / pts.length;
}

function distToLine(p: Pt, a: Pt, b: Pt) {
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  if (l < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / l;
}

function distToSeg(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l, 0, 1) : 0;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

function polyLen(p: Pt[]) {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return l;
}

function bounds(p: Pt[]) {
  const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
