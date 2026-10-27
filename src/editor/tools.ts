// Tools are small state machines over the input pipeline. They receive samples
// in world coordinates and emit ops into the document.
import { objBounds, strokeBBox } from '../model/doc';
import type { Op, PageObject, StrokeObj, TextObj } from '../model/types';
import { splitStroke, sweepBounds, sweepHitsStroke, pointNearStroke, type Sweep } from '../ink/erase';
import { recognizeShape, type Shape } from '../ink/shapes';
import { InkFilter, densify, simplify, straighten, toFlat, type InkPoint, type Sample } from '../ink/stroke';
import { inRect, inflate, intersects, pointInPolygon, union, type Pt, type Rect } from '../util/geom';
import { uid } from '../util/ids';
import type { PageView } from '../render/pageView';
import { drawObject, isDark, paintInk } from '../render/draw';
import type { Editor } from './editor';
import { settings } from './settings';

export interface Tool {
  down(s: Sample): void;
  move(samples: Sample[], predicted: Sample[]): void;
  up(s: Sample): void;
  cancel(): void;
  overlay?(ctx: CanvasRenderingContext2D): void;
  deactivate?(): void;
}

const local = (pv: PageView, s: Sample): Sample => ({ x: s.x - pv.x, y: s.y - pv.y, p: s.p, t: s.t });

// ---------------------------------------------------------------- ink / shapes

export class InkTool implements Tool {
  private live: {
    pv: PageView; filter: InkFilter; raw: Sample[]; pred: InkPoint[]; tip: InkPoint | null;
    createdAt: number; anchor: Pt; shape: Shape | null; timer: number;
  } | null = null;

  constructor(private ed: Editor, private kind: 'pen' | 'highlighter' | 'shape') {}

  private style() {
    return this.kind === 'highlighter'
      ? { width: settings.highlighter.width, pressure: false }
      : { width: settings.pen.width, pressure: settings.pen.pressure && this.kind === 'pen' };
  }

  down(s: Sample) {
    const pv = this.ed.pageAt(s.x, s.y, true);
    if (!pv) return;
    const l = local(pv, s);
    const filter = new InkFilter({ ...this.style(), zoom: this.ed.cam.z });
    filter.push(l);
    this.live = { pv, filter, raw: [l], pred: [], tip: null, createdAt: this.ed.timeline(), anchor: { x: l.x, y: l.y }, shape: null, timer: 0 };
    this.arm();
    this.ed.requestFrame();
  }

  move(samples: Sample[], predicted: Sample[]) {
    const L = this.live;
    if (!L) return;
    const slop = 4 / this.ed.cam.z;
    for (const s of samples) {
      const l = local(L.pv, s);
      L.raw.push(l);
      L.filter.push(l);
      if (Math.hypot(l.x - L.anchor.x, l.y - L.anchor.y) > slop) {
        L.anchor = { x: l.x, y: l.y };
        L.shape = null;
        this.arm();
      }
    }
    // The smoothed path trails the pen slightly; draw through to the real tip so
    // ink stays glued to it. Predicted points extend it a frame ahead (never committed).
    const w = L.filter.pts.at(-1)?.w ?? this.style().width;
    const last = L.raw[L.raw.length - 1];
    L.tip = { x: last.x, y: last.y, w };
    L.pred = predicted.slice(0, 1).map((s) => { const l = local(L.pv, s); return { x: l.x, y: l.y, w }; });
    this.ed.requestFrame();
  }

  /** Hold still at the end of a pen stroke to snap it into a perfect shape. */
  private arm() {
    const L = this.live;
    if (!L || this.kind !== 'pen' || !settings.holdToSnap) return;
    clearTimeout(L.timer);
    L.timer = window.setTimeout(() => {
      if (this.live !== L) return;
      L.shape = recognizeShape(L.raw);
      if (L.shape) { navigator.vibrate?.(8); this.ed.requestFrame(); }
    }, 600);
  }

  up(s: Sample) {
    this.move([s], []);
    const L = this.live;
    if (!L) return;
    clearTimeout(L.timer);
    this.live = null;
    const shape = L.shape ?? (this.kind === 'shape' ? recognizeShape(L.raw) : null);
    let pts: InkPoint[];
    if (shape) pts = shapeInk(shape, avgWidth(L.filter.pts, this.style().width));
    else {
      pts = L.filter.finish(L.raw.at(-1));
      pts = this.kind === 'highlighter' && settings.straightLines ? straighten(pts) ?? simplify(pts) : simplify(pts);
    }
    if (!pts.length) { this.ed.requestFrame(); return; }
    const hl = this.kind === 'highlighter';
    const flat = toFlat(pts);
    const obj: StrokeObj = {
      kind: 'stroke', id: uid(), page: L.pv.page.id, createdAt: L.createdAt,
      tool: hl ? 'highlighter' : 'pen',
      color: hl ? settings.highlighter.color : settings.pen.color,
      opacity: hl ? 0.5 : 1, pts: flat, bbox: strokeBBox(flat),
    };
    this.ed.commitContent([{ t: 'add', obj }], L.pv.page.id);
  }

  cancel() {
    if (this.live) clearTimeout(this.live.timer);
    this.live = null;
    this.ed.requestFrame();
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const L = this.live;
    if (!L) return;
    this.ed.pageTransform(ctx, L.pv);
    const pts = L.shape ? shapeInk(L.shape, avgWidth(L.filter.pts, this.style().width)) : [...L.filter.view(), ...(L.tip ? [L.tip] : []), ...L.pred];
    const hl = this.kind === 'highlighter';
    ctx.globalAlpha = hl ? 0.5 : 1;
    if (hl && !isDark(L.pv.page.paper)) ctx.globalCompositeOperation = 'multiply';
    paintInk(ctx, pts, hl ? settings.highlighter.color : settings.pen.color, hl);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function avgWidth(pts: InkPoint[], fallback: number) {
  return pts.length ? pts.reduce((s, p) => s + p.w, 0) / pts.length : fallback;
}

/** Shapes become ordinary ink; dense edges keep the spline from bowing them. */
function shapeInk(shape: Shape, w: number): InkPoint[] {
  const pts = shape.pts.map((p) => ({ x: p.x, y: p.y, w }));
  return shape.kind === 'line' ? pts : shape.kind === 'ellipse' ? pts : densify(pts, 3);
}

// ---------------------------------------------------------------- eraser

export class EraserTool implements Tool {
  private last: Sample | null = null;

  constructor(private ed: Editor) {}

  private get r() { return settings.eraser.size / 2 / this.ed.cam.z; }

  down(s: Sample) {
    this.ed.doc.begin();
    this.last = s;
    this.sweep(s, s);
    this.ed.requestFrame();
  }

  move(samples: Sample[]) {
    if (!this.last) return;
    for (const s of samples) { this.sweep(this.last, s); this.last = s; }
    this.ed.requestFrame();
  }

  up(s: Sample) {
    this.move([s]);
    this.ed.doc.end();
    this.last = null;
    this.ed.requestFrame();
    if (settings.autoDeselectEraser) this.ed.setTool(this.ed.prevTool);
  }

  cancel() { this.ed.doc.end(); this.last = null; this.ed.requestFrame(); }

  private sweep(a: Sample, b: Sample) {
    const r = this.r;
    const world = sweepBounds({ ax: a.x, ay: a.y, bx: b.x, by: b.y, r });
    const { mode, highlighterOnly } = settings.eraser;
    for (const pv of this.ed.pages) {
      if (!intersects(pv.bounds, world)) continue;
      const sw: Sweep = { ax: a.x - pv.x, ay: a.y - pv.y, bx: b.x - pv.x, by: b.y - pv.y, r };
      const sb = sweepBounds(sw);
      const ops: Op[] = [];
      for (const o of this.ed.doc.state.objectsOn(pv.page.id)) {
        if (o.kind !== 'stroke' || !intersects(o.bbox, sb)) continue;
        if (highlighterOnly && o.tool !== 'highlighter') continue;
        if (mode === 'stroke') {
          if (sweepHitsStroke(o.pts, sw)) ops.push({ t: 'remove', id: o.id });
          continue;
        }
        const parts = splitStroke(o.pts, sw);
        if (!parts) continue;
        ops.push({ t: 'remove', id: o.id });
        for (const pts of parts) ops.push({ t: 'add', obj: { ...o, id: uid(), pts, bbox: strokeBBox(pts) } });
      }
      if (ops.length) this.ed.doc.commit(ops);
    }
  }

  overlay(ctx: CanvasRenderingContext2D) {
    if (!this.last) return;
    this.ed.worldTransform(ctx);
    ctx.beginPath();
    ctx.arc(this.last.x, this.last.y, this.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
    ctx.lineWidth = 1.2 / this.ed.cam.z;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- lasso / selection

export interface Selection { ids: string[]; bounds: Rect }

let clipboard: PageObject[] | null = null;
/** Selection outline / handle color. */
const SEL = '#4f7cf6';

/** Snap to straight angles (0°, ±90°, 180°) when within 4°. */
function snapAngle(a: number) {
  // Keep within -180°..180° so a small twist never reads as -315°.
  a = Math.atan2(Math.sin(a), Math.cos(a));
  const q = Math.PI / 2, near = Math.round(a / q) * q;
  return Math.abs(a - near) < (4 * Math.PI) / 180 ? near : a;
}
/** Placed on the system clipboard by Inkwell's copy, so a paste knows to use the copied ink. */
export const OBJECTS_MARKER = '\u2063inkwell-objects\u2063';
export const hasClipboard = () => !!clipboard?.length;

/** Rebuild an object through a coordinate map; k scales widths/sizes. */
function mapObj<T extends PageObject>(o: T, fx: (x: number) => number, fy: (y: number) => number, k: number): T {
  if (o.kind === 'stroke') {
    const pts = o.pts.slice();
    for (let i = 0; i < pts.length; i += 3) {
      pts[i] = Math.round(fx(pts[i]) * 100) / 100;
      pts[i + 1] = Math.round(fy(pts[i + 1]) * 100) / 100;
      pts[i + 2] = Math.round(pts[i + 2] * k * 100) / 100;
    }
    return { ...o, pts, bbox: strokeBBox(pts) };
  }
  const n = { ...o, x: fx(o.x), y: fy(o.y), w: o.w * k, h: o.h * k } as T;
  if (n.kind === 'text') (n as TextObj).size = (o as TextObj).size * k;
  return n;
}

/** A selection transform: scale and rotate about a pivot, then translate. */
interface Xf { px: number; py: number; s: number; a: number; dx: number; dy: number }
const NO_XF: Xf = { px: 0, py: 0, s: 1, a: 0, dx: 0, dy: 0 };

function applyXf(t: Xf, x: number, y: number): Pt {
  const c = Math.cos(t.a) * t.s, si = Math.sin(t.a) * t.s;
  const rx = x - t.px, ry = y - t.py;
  return { x: t.px + rx * c - ry * si + t.dx, y: t.py + rx * si + ry * c + t.dy };
}

/** Apply a transform (pivot in the object's own page coordinates). */
export function xfObj<T extends PageObject>(o: T, t: Xf): T {
  if (o.kind === 'stroke') {
    const pts = o.pts.slice();
    for (let i = 0; i < pts.length; i += 3) {
      const q = applyXf(t, pts[i], pts[i + 1]);
      pts[i] = Math.round(q.x * 100) / 100;
      pts[i + 1] = Math.round(q.y * 100) / 100;
      pts[i + 2] = Math.round(pts[i + 2] * t.s * 100) / 100;
    }
    return { ...o, pts, bbox: strokeBBox(pts) };
  }
  // Sticky notes keep their size and stay upright; only their position follows.
  if (o.kind === 'sticky') { const q = applyXf(t, o.x, o.y); return { ...o, x: q.x, y: q.y }; }
  const c = applyXf(t, o.x + o.w / 2, o.y + o.h / 2);
  const w = o.w * t.s, h = o.h * t.s;
  let rot = ((o.rot ?? 0) + t.a) % (Math.PI * 2);
  if (Math.abs(rot) < 1e-3) rot = 0;
  const n = { ...o, x: c.x - w / 2, y: c.y - h / 2, w, h, rot } as T;
  if (n.kind === 'text') (n as TextObj).size = (o as TextObj).size * t.s;
  return n;
}

function segsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

export class LassoTool implements Tool {
  sel: Selection | null = null;
  private mode: 'none' | 'lasso' | 'move' | 'scale' | 'rotate' | 'gesture' = 'none';
  private poly: Pt[] = [];
  private start: Pt = { x: 0, y: 0 };
  private startAngle = 0;
  private xf: Xf = { ...NO_XF };

  constructor(private ed: Editor) {}

  private pad() { return 6 / this.ed.cam.z; }
  /** Resize dot (bottom-right) and rotate dot (top-right), in world coords. */
  private handles() {
    const b = this.sel!.bounds, pad = this.pad();
    return { scale: { x: b.x + b.w + pad, y: b.y + b.h + pad }, rotate: { x: b.x + b.w + pad, y: b.y - pad } };
  }
  private center(): Pt { const b = this.sel!.bounds; return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

  private begin(mode: 'move' | 'scale' | 'rotate' | 'gesture', p: Pt) {
    this.mode = mode;
    this.start = { x: p.x, y: p.y };
    const b = this.sel!.bounds, c = this.center();
    const pivot = mode === 'scale' ? { x: b.x, y: b.y } : c;
    this.xf = { ...NO_XF, px: pivot.x, py: pivot.y };
    this.startAngle = Math.atan2(p.y - c.y, p.x - c.x);
    this.ed.setHidden(this.sel!.ids);
    this.ed.text.hide(this.sel!.ids);
    this.ed.hideSelectionMenu();
  }

  down(p: Sample) {
    if (this.sel) {
      const h = this.handles(), z = this.ed.cam.z;
      if (Math.hypot(p.x - h.rotate.x, p.y - h.rotate.y) * z < 26) { this.begin('rotate', p); return; }
      if (Math.hypot(p.x - h.scale.x, p.y - h.scale.y) * z < 26) { this.begin('scale', p); return; }
      if (inRect(inflate(this.sel.bounds, 10 / z), p.x, p.y)) { this.begin('move', p); return; }
    }
    this.clear();
    this.mode = 'lasso';
    this.poly = [{ x: p.x, y: p.y }];
  }

  move(samples: Sample[]) {
    const p = samples.at(-1);
    if (!p) return;
    if (this.mode === 'lasso' && settings.lassoMode === 'rect') {
      const a = this.poly[0];
      this.poly = [a, { x: p.x, y: a.y }, { x: p.x, y: p.y }, { x: a.x, y: p.y }];
    } else if (this.mode === 'lasso') {
      for (const s of samples) {
        const l = this.poly[this.poly.length - 1];
        if (Math.hypot(s.x - l.x, s.y - l.y) * this.ed.cam.z > 2) this.poly.push({ x: s.x, y: s.y });
      }
    } else if (this.mode === 'move') {
      this.xf.dx = p.x - this.start.x;
      this.xf.dy = p.y - this.start.y;
    } else if (this.mode === 'scale') {
      const b = this.sel!.bounds;
      const s = ((p.x - b.x) * b.w + (p.y - b.y) * b.h) / (b.w * b.w + b.h * b.h || 1);
      this.xf.s = Math.min(8, Math.max(0.1, s));
    } else if (this.mode === 'rotate') {
      const c = this.center();
      this.xf.a = snapAngle(Math.atan2(p.y - c.y, p.x - c.x) - this.startAngle);
    }
    this.ed.requestFrame();
  }

  // Two-finger gesture on a selection (iPad): pinch to resize, twist to rotate, slide to move.
  gestureStart(at: Pt): boolean {
    if (!this.sel || !inRect(inflate(this.sel.bounds, 24 / this.ed.cam.z), at.x, at.y)) return false;
    this.begin('gesture', at);
    return true;
  }
  gestureUpdate(scale: number, angle: number, dx: number, dy: number) {
    if (this.mode !== 'gesture') return;
    this.xf.s = Math.min(8, Math.max(0.1, scale));
    this.xf.a = snapAngle(angle);
    this.xf.dx = dx;
    this.xf.dy = dy;
    this.ed.requestFrame();
  }
  gestureEnd() { if (this.mode === 'gesture') this.finish(); }

  private finish() {
    const t = this.xf;
    this.mode = 'none';
    this.ed.setHidden([]);
    this.ed.text.hide([]);
    const changed = Math.hypot(t.dx, t.dy) * this.ed.cam.z > 1 || Math.abs(t.s - 1) > 0.005 || Math.abs(t.a) > 0.002;
    if (changed) this.commitTransform();
    this.xf = { ...NO_XF };
    this.refresh();
    this.ed.requestFrame();
  }

  up(p: Sample) {
    this.move([p]);
    const mode = this.mode;
    if (mode === 'lasso') {
      this.mode = 'none';
      let len = 0;
      for (let i = 1; i < this.poly.length; i++) len += Math.hypot(this.poly[i].x - this.poly[i - 1].x, this.poly[i].y - this.poly[i - 1].y);
      if (len * this.ed.cam.z < 8) this.selectAt(p);
      else this.selectPoly(this.poly);
      this.poly = [];
      this.ed.requestFrame();
    } else if (mode !== 'none') this.finish();
  }

  cancel() {
    if (this.mode !== 'none' && this.mode !== 'lasso') { this.ed.setHidden([]); this.ed.text.hide([]); }
    this.mode = 'none';
    this.xf = { ...NO_XF };
    this.poly = [];
    this.ed.requestFrame();
  }

  deactivate() { this.cancel(); this.clear(); }

  private commitTransform() {
    const sel = this.sel!;
    const ops: Op[] = [];
    const t = this.xf;
    for (const id of sel.ids) {
      const o = this.ed.doc.state.objects.get(id);
      if (!o) continue;
      const pv = this.ed.pageView(o.page)!;
      const n = xfObj(o, { ...t, px: t.px - pv.x, py: t.py - pv.y });
      // Dropped onto another page? Re-home the object there.
      const nb = objBounds(n);
      const target = this.ed.pageAt(pv.x + nb.x + nb.w / 2, pv.y + nb.y + nb.h / 2, false);
      if (target && target !== pv) {
        const moved = { ...xfObj(n, { ...NO_XF, dx: pv.x - target.x, dy: pv.y - target.y }), page: target.page.id };
        ops.push({ t: 'remove', id }, { t: 'add', obj: moved });
      } else {
        ops.push({ t: 'update', id, patch: n });
      }
    }
    this.ed.doc.commit(ops);
  }

  private selectAt(p: Sample) {
    const hit = this.ed.objectAt(p.x, p.y);
    if (hit) this.setSel([hit.id]);
  }

  /** Anything the lasso touches is selected whole, even if only part of it is inside. */
  private selectPoly(poly: Pt[]) {
    if (poly.length < 3) return;
    let pb: Rect | null = null;
    for (const q of poly) pb = union(pb, { x: q.x, y: q.y, w: 0, h: 0 });
    const edges = poly.map((q, i) => [q, poly[(i + 1) % poly.length]] as const);
    const ids: string[] = [];
    for (const pv of this.ed.pages) {
      if (!intersects(pv.bounds, pb!)) continue;
      for (const o of this.ed.doc.state.objectsOn(pv.page.id)) {
        const b = objBounds(o);
        const wb = { x: b.x + pv.x, y: b.y + pv.y, w: b.w, h: b.h };
        if (!intersects(wb, pb!)) continue;
        let hit = false;
        if (o.kind === 'stroke') {
          const n = o.pts.length / 3;
          for (let i = 0; i < n && !hit; i++) {
            const q = { x: o.pts[i * 3] + pv.x, y: o.pts[i * 3 + 1] + pv.y };
            if (pointInPolygon(q.x, q.y, poly)) hit = true;
            else if (i > 0) {
              const prev = { x: o.pts[i * 3 - 3] + pv.x, y: o.pts[i * 3 - 2] + pv.y };
              for (const [e0, e1] of edges) if (segsCross(prev, q, e0, e1)) { hit = true; break; }
            }
          }
        } else {
          const corners = [[wb.x, wb.y], [wb.x + wb.w, wb.y], [wb.x, wb.y + wb.h], [wb.x + wb.w, wb.y + wb.h], [wb.x + wb.w / 2, wb.y + wb.h / 2]];
          hit = corners.some(([x, y]) => pointInPolygon(x, y, poly)) || poly.some((q) => inRect(wb, q.x, q.y));
        }
        if (hit) ids.push(o.id);
      }
    }
    if (ids.length) this.setSel(ids);
  }

  setSel(ids: string[]) {
    this.sel = { ids, bounds: { x: 0, y: 0, w: 0, h: 0 } };
    this.refresh();
  }

  /** Re-derive the selection after any document change (undo can remove things). */
  refresh() {
    if (!this.sel) return;
    const st = this.ed.doc.state;
    const ids = this.sel.ids.filter((id) => st.objects.has(id));
    if (!ids.length) { this.clear(); return; }
    let b: Rect | null = null;
    for (const id of ids) {
      const o = st.objects.get(id)!;
      const pv = this.ed.pageView(o.page);
      if (!pv) continue;
      const ob = objBounds(o);
      b = union(b, { x: ob.x + pv.x, y: ob.y + pv.y, w: ob.w, h: ob.h });
    }
    this.sel = { ids, bounds: b! };
    this.ed.showSelectionMenu();
    this.ed.requestFrame();
  }

  clear() {
    if (!this.sel) return;
    this.sel = null;
    this.ed.hideSelectionMenu();
    this.ed.requestFrame();
  }

  objects(): PageObject[] {
    return (this.sel?.ids ?? []).map((id) => this.ed.doc.state.objects.get(id)!).filter(Boolean);
  }

  remove() {
    this.ed.doc.commit(this.objects().map((o): Op => ({ t: 'remove', id: o.id })));
    this.clear();
  }

  recolor(color: string) {
    const ops: Op[] = [];
    for (const o of this.objects()) if (o.kind !== 'image') ops.push({ t: 'update', id: o.id, patch: { color } });
    this.ed.doc.commit(ops);
  }

  copy() {
    clipboard = this.objects().map((o) => {
      const pv = this.ed.pageView(o.page)!;
      return mapObj(o, (x) => x + pv.x, (y) => y + pv.y, 1); // store in world coords
    });
    navigator.clipboard?.writeText(OBJECTS_MARKER).catch(() => {});
  }

  duplicate() {
    this.copy();
    const b = this.sel!.bounds;
    this.paste({ x: b.x + b.w / 2 + 20, y: b.y + b.h / 2 + 20 });
  }

  /** Paste the clipboard centered on a world point. */
  paste(at: Pt) {
    if (!clipboard?.length) return;
    const pv = this.ed.pageAt(at.x, at.y, true);
    if (!pv) return;
    let b: Rect | null = null;
    for (const o of clipboard) b = union(b, objBounds(o));
    const ox = at.x - (b!.x + b!.w / 2) - pv.x, oy = at.y - (b!.y + b!.h / 2) - pv.y;
    const t = this.ed.timeline();
    const objs = clipboard.map((o) => ({ ...mapObj(o, (x) => x + ox, (y) => y + oy, 1), id: uid(), page: pv.page.id, createdAt: t }));
    this.ed.commitContent(objs.map((obj): Op => ({ t: 'add', obj })), pv.page.id);
    this.setSel(objs.map((o) => o.id));
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const ed = this.ed, z = ed.cam.z;
    if (this.mode === 'lasso' && this.poly.length > 1) {
      ed.worldTransform(ctx);
      ctx.beginPath();
      this.poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (settings.lassoMode === 'rect') ctx.closePath();
      ctx.fillStyle = 'rgba(79,124,246,0.07)';
      ctx.fill();
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = SEL;
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (!this.sel) return;
    const b = this.sel.bounds;
    const t = this.xf;
    const dragging = this.mode !== 'none' && this.mode !== 'lasso';
    if (dragging) {
      for (const o of this.objects()) {
        const pv = ed.pageView(o.page)!;
        ed.pageTransform(ctx, pv, false);
        const local = { ...t, px: t.px - pv.x, py: t.py - pv.y };
        const opts = { darkPaper: isDark(pv.page.paper), text: true };
        if (o.kind === 'sticky') { drawObject(ctx, xfObj(o, local), opts); continue; }
        ctx.translate(local.dx + local.px, local.dy + local.py);
        ctx.rotate(local.a);
        ctx.scale(local.s, local.s);
        ctx.translate(-local.px, -local.py);
        drawObject(ctx, o, opts);
      }
    }
    ed.worldTransform(ctx);
    const pad = this.pad();
    const corners = [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]].map(([x, y]) => applyXf(t, x, y));
    ctx.beginPath();
    corners.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = SEL;
    ctx.stroke();
    ctx.setLineDash([]);
    // Resize dot (bottom-right).
    ctx.beginPath();
    ctx.arc(corners[2].x, corners[2].y, 7 / z, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2 / z;
    ctx.stroke();
    // Rotate handle (top-right): a filled dot with a curved arrow.
    const r = corners[1];
    ctx.beginPath();
    ctx.arc(r.x, r.y, 9 / z, 0, Math.PI * 2);
    ctx.fillStyle = SEL;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(r.x, r.y, 4.5 / z, -Math.PI * 0.9, Math.PI * 0.5);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.6 / z;
    ctx.stroke();
    ctx.beginPath();
    const tip = { x: r.x + Math.cos(Math.PI * 0.5) * 4.5 / z, y: r.y + Math.sin(Math.PI * 0.5) * 4.5 / z };
    ctx.moveTo(tip.x - 2.6 / z, tip.y - 0.4 / z);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(tip.x + 0.6 / z, tip.y - 2.6 / z);
    ctx.stroke();
    if (this.mode === 'rotate' || this.mode === 'gesture') {
      // Show the angle while turning.
      const deg = Math.round((t.a * 180) / Math.PI);
      const c = applyXf(t, b.x + b.w / 2, b.y + b.h / 2);
      ctx.font = `600 ${12 / z}px -apple-system, system-ui, sans-serif`;
      const label = `${deg}°`;
      const w = ctx.measureText(label).width + 12 / z;
      ctx.fillStyle = 'rgba(28,28,30,0.82)';
      ctx.beginPath();
      ctx.roundRect(c.x - w / 2, c.y - 11 / z, w, 22 / z, 11 / z);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, c.x, c.y);
    }
  }

}

// ---------------------------------------------------------------- text

export class TextTool implements Tool {
  private at: Sample | null = null;
  constructor(private ed: Editor) {}

  down(s: Sample) { this.at = s; }
  move() {}
  cancel() { this.at = null; }

  up(s: Sample) {
    const a = this.at;
    this.at = null;
    if (!a || Math.hypot(s.x - a.x, s.y - a.y) * this.ed.cam.z > 12) return;
    this.tap(s);
  }

  tap(s: Pt) {
    const hit = this.ed.objectAt(s.x, s.y, (o) => o.kind === 'text');
    if (hit) { this.ed.text.edit(hit.id); return; }
    const pv = this.ed.pageAt(s.x, s.y, false);
    if (!pv) return;
    const t = settings.text;
    const lx = s.x - pv.x, ly = s.y - pv.y;
    const obj: TextObj = {
      kind: 'text', id: uid(), page: pv.page.id, createdAt: this.ed.timeline(),
      x: lx, y: Math.max(0, ly - t.size * 0.65),
      w: Math.max(140, Math.min(380, pv.page.w - lx - 24)), h: t.size * 1.3,
      text: '', size: t.size, color: t.color, bold: t.bold, font: t.font,
    };
    this.ed.text.draft(obj);
  }
}

/** Top-most object under a world point. */
export function hitObject(objs: PageObject[], x: number, y: number, slop: number, filter?: (o: PageObject) => boolean) {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (filter && !filter(o)) continue;
    if (o.kind === 'stroke') {
      if (inRect(inflate(o.bbox, slop), x, y) && pointNearStroke(o.pts, x, y, slop)) return o;
    } else if (inRect(inflate(objBounds(o), slop / 2), x, y)) return o;
  }
  return null;
}

