import { describe, expect, it } from 'vitest';
import { splitStroke, sweepHitsStroke } from '../src/ink/erase';
import { recognizeShape } from '../src/ink/shapes';
import { InkFilter, buildPath, simplify, straighten, toFlat, type InkPoint } from '../src/ink/stroke';

const line = (n: number, f: (i: number) => [number, number]): InkPoint[] =>
  Array.from({ length: n }, (_, i) => { const [x, y] = f(i); return { x, y, w: 2 }; });

describe('ink', () => {
  it('simplify collapses a straight run', () => {
    const pts = line(200, (i) => [i, 2 * i]);
    const s = simplify(pts);
    expect(s.length).toBe(2);
    expect(s[0]).toEqual(pts[0]);
    expect(s[1]).toEqual(pts[199]);
  });

  it('simplify keeps curvature', () => {
    const pts = line(400, (i) => [100 + 80 * Math.cos(i / 63.66), 100 + 80 * Math.sin(i / 63.66)]);
    const s = simplify(pts);
    expect(s.length).toBeGreaterThan(20);
    expect(s.length).toBeLessThan(120);
  });

  it('filter thickens with pressure', () => {
    const f = new InkFilter({ width: 2, pressure: true });
    expect(f.width(1, 0)).toBeGreaterThan(f.width(0.1, 0));
    expect(f.width(1, 5)).toBeLessThan(f.width(1, 0));
  });

  it('filter skips sub-pixel jitter', () => {
    const f = new InkFilter({ width: 2, pressure: false });
    f.push({ x: 0, y: 0, p: 0.5, t: 0 });
    expect(f.push({ x: 0.1, y: 0.1, p: 0.5, t: 8 })).toBeNull();
  });

  it('buildPath emits a closed outline', () => {
    const calls: string[] = [];
    const sink = {
      moveTo: () => calls.push('m'), lineTo: () => calls.push('l'),
      arc: () => calls.push('a'), closePath: () => calls.push('z'),
    };
    buildPath(sink, line(10, (i) => [i * 5, 0]));
    expect(calls[0]).toBe('m');
    expect(calls.filter((c) => c === 'a').length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain('z');
  });

  it('straighten snaps a wobbly horizontal line', () => {
    const s = straighten(line(50, (i) => [i * 4, 100 + Math.sin(i) * 1.5]));
    expect(s).not.toBeNull();
    expect(s![0].y).toBe(s![1].y);
  });

  it('partial erase splits a stroke in two', () => {
    const flat = toFlat([{ x: 0, y: 0, w: 2 }, { x: 100, y: 0, w: 2 }]);
    const parts = splitStroke(flat, { ax: 50, ay: -10, bx: 50, by: 10, r: 5 });
    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(2);
    expect(parts![0][parts![0].length - 3]).toBeLessThan(46);
    expect(parts![1][0]).toBeGreaterThan(54);
  });

  it('erase misses distant strokes and hits long sparse segments', () => {
    const flat = toFlat([{ x: 0, y: 0, w: 2 }, { x: 300, y: 0, w: 2 }]);
    expect(sweepHitsStroke(flat, { ax: 150, ay: 40, bx: 150, by: 40, r: 5 })).toBe(false);
    expect(sweepHitsStroke(flat, { ax: 150, ay: 3, bx: 150, by: 3, r: 5 })).toBe(true);
    expect(splitStroke(flat, { ax: 150, ay: 40, bx: 160, by: 40, r: 5 })).toBeNull();
  });
});

describe('shape recognition', () => {
  const jitter = (i: number) => Math.sin(i * 7.3) * 1.2;

  it('line', () => {
    const r = recognizeShape(Array.from({ length: 40 }, (_, i) => ({ x: i * 5, y: i * 2 + jitter(i) })));
    expect(r?.kind).toBe('line');
  });

  it('circle', () => {
    const pts = Array.from({ length: 80 }, (_, i) => ({
      x: 200 + (60 + jitter(i)) * Math.cos((i / 80) * Math.PI * 2),
      y: 200 + (60 + jitter(i)) * Math.sin((i / 80) * Math.PI * 2),
    }));
    expect(recognizeShape(pts)?.kind).toBe('ellipse');
  });

  it('rectangle', () => {
    const pts: { x: number; y: number }[] = [];
    const corners = [[0, 0], [200, 0], [200, 100], [0, 100], [0, 0]];
    for (let c = 0; c < 4; c++) {
      const [x0, y0] = corners[c], [x1, y1] = corners[c + 1];
      for (let i = 0; i < 25; i++) pts.push({ x: x0 + (x1 - x0) * i / 25 + jitter(i), y: y0 + (y1 - y0) * i / 25 + jitter(i + 3) });
    }
    const r = recognizeShape(pts);
    expect(r?.kind).toBe('rectangle');
  });

  it('triangle', () => {
    const pts: { x: number; y: number }[] = [];
    const corners = [[0, 150], [100, 0], [200, 150], [0, 150]];
    for (let c = 0; c < 3; c++) {
      const [x0, y0] = corners[c], [x1, y1] = corners[c + 1];
      for (let i = 0; i < 30; i++) pts.push({ x: x0 + (x1 - x0) * i / 30 + jitter(i), y: y0 + (y1 - y0) * i / 30 });
    }
    expect(recognizeShape(pts)?.kind).toBe('triangle');
  });

  it('scribble is not a shape', () => {
    const pts = Array.from({ length: 60 }, (_, i) => ({ x: i * 4, y: (i % 2) * 40 }));
    expect(recognizeShape(pts)).toBeNull();
  });
});

describe('stroke outline winding', () => {
  // Every emitted piece must wind the same way, or overlaps cancel into holes.
  it('all pieces have positive signed area', () => {
    const pts: InkPoint[] = [];
    for (let i = 0; i < 40; i++) pts.push({ x: (i % 2) * 60 + i, y: i * 3, w: 6 }); // fast zig-zag
    const polys: number[][][] = [];
    let cur: number[][] = [];
    const sink = {
      moveTo: (x: number, y: number) => { cur = [[x, y]]; polys.push(cur); },
      lineTo: (x: number, y: number) => { cur.push([x, y]); },
      arc: (x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean) => {
        expect(ccw ?? false).toBe(false);
        for (let k = 1; k <= 16; k++) { const t = a0 + ((a1 - a0) * k) / 16; cur.push([x + r * Math.cos(t), y + r * Math.sin(t)]); }
      },
      closePath: () => {},
    };
    buildPath(sink, pts);
    expect(polys.length).toBeGreaterThan(10);
    for (const poly of polys) {
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
        area += x0 * y1 - x1 * y0;
      }
      expect(area).toBeGreaterThan(0);
    }
  });
});

describe('ink smoothing', () => {
  it('irons out pixel-quantized mouse input on slow strokes', () => {
    // A slow, shallow diagonal as a mouse reports it: whole-pixel staircase steps.
    const f = new InkFilter({ width: 2, pressure: true, zoom: 1 });
    for (let i = 0; i <= 120; i++) f.push({ x: i, y: Math.round(i * 0.3), p: 0.5, t: i * 8 });
    const pts = f.finish();
    // Ideal line y = 0.3x; compare the middle where the filter has settled.
    const mid = pts.filter((p) => p.x > 20 && p.x < 100);
    const worst = Math.max(...mid.map((p) => Math.abs(p.y - 0.3 * p.x)));
    expect(worst).toBeLessThan(0.75); // raw staircase error reaches 0.5 and jumps 1px at a time
    // Consecutive slope changes stay tiny: no visible steps.
    let maxTurn = 0;
    for (let i = 2; i < mid.length; i++) {
      const a = Math.atan2(mid[i - 1].y - mid[i - 2].y, mid[i - 1].x - mid[i - 2].x);
      const b = Math.atan2(mid[i].y - mid[i - 1].y, mid[i].x - mid[i - 1].x);
      maxTurn = Math.max(maxTurn, Math.abs(b - a));
    }
    expect(maxTurn).toBeLessThan(0.35);
  });

  it('tapers pen strokes at both ends', () => {
    const f = new InkFilter({ width: 3, pressure: true, zoom: 1 });
    for (let i = 0; i <= 60; i++) f.push({ x: i * 2, y: 0, p: 0.5, t: i * 8 });
    const pts = f.finish();
    const midW = pts[Math.floor(pts.length / 2)].w;
    expect(pts[0].w).toBeLessThan(midW * 0.8);
    expect(pts[pts.length - 1].w).toBeLessThan(midW * 0.8);
  });
});
