// Vector erasing. Whole-stroke erase removes objects; partial erase splits
// the path into surviving runs. Nothing ever paints background color.
import { distSqToSeg, type Rect } from '../util/geom';
import { densify, fromFlat, simplify, toFlat, type InkPoint } from './stroke';

/** The eraser gesture as a swept circle from (ax,ay) to (bx,by). */
export interface Sweep { ax: number; ay: number; bx: number; by: number; r: number }

export function sweepBounds(s: Sweep): Rect {
  return {
    x: Math.min(s.ax, s.bx) - s.r, y: Math.min(s.ay, s.by) - s.r,
    w: Math.abs(s.bx - s.ax) + 2 * s.r, h: Math.abs(s.by - s.ay) + 2 * s.r,
  };
}

/** Does the sweep touch the stroke ribbon? */
export function sweepHitsStroke(pts: number[], s: Sweep): boolean {
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], w = pts[i * 3 + 2];
    const reach = s.r + w / 2;
    if (distSqToSeg(x, y, s.ax, s.ay, s.bx, s.by) <= reach * reach) return true;
    if (i > 0) {
      // Segment-vs-sweep: sample the stroke segment so long straight spans still register.
      const px = pts[i * 3 - 3], py = pts[i * 3 - 2];
      const len = Math.hypot(x - px, y - py);
      const steps = Math.ceil(len / Math.max(1, s.r));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const qx = px + (x - px) * t, qy = py + (y - py) * t;
        if (distSqToSeg(qx, qy, s.ax, s.ay, s.bx, s.by) <= reach * reach) return true;
      }
    }
  }
  return false;
}

/**
 * Cut the swept region out of a stroke. Returns null if untouched, otherwise
 * the flat point arrays of the surviving pieces (possibly empty).
 */
export function splitStroke(pts: number[], s: Sweep): number[][] | null {
  const dense = densify(fromFlat(pts), 1);
  let touched = false;
  const runs: InkPoint[][] = [];
  let cur: InkPoint[] = [];
  for (const p of dense) {
    const reach = s.r + p.w * 0.25;
    if (distSqToSeg(p.x, p.y, s.ax, s.ay, s.bx, s.by) <= reach * reach) {
      touched = true;
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (!touched) return null;
  if (cur.length) runs.push(cur);
  return runs
    .filter((r) => r.length > 1 && pathLen(r) > 0.8)
    .map((r) => toFlat(simplify(r, 0.15)));
}

function pathLen(r: InkPoint[]) {
  let l = 0;
  for (let i = 1; i < r.length; i++) l += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y);
  return l;
}

/** Hit test a point against a stroke (for tap-to-seek / text tool hit). */
export function pointNearStroke(pts: number[], x: number, y: number, slop: number): boolean {
  return sweepHitsStroke(pts, { ax: x, ay: y, bx: x, by: y, r: slop });
}
