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

export class LassoTool implements Tool {
  sel: Selection | null = null;
  private mode: 'none' | 'lasso' | 'move' | 'scale' = 'none';
  private poly: Pt[] = [];
  private start: Pt = { x: 0, y: 0 };
  private dx = 0;
  private dy = 0;
  private s = 1;

  constructor(private ed: Editor) {}

  private handle() {
    const b = this.sel!.bounds;
    return { x: b.x + b.w, y: b.y + b.h };
  }

  down(p: Sample) {
    if (this.sel) {
      const h = this.handle();
      const z = this.ed.cam.z;
      if (Math.hypot(p.x - h.x, p.y - h.y) * z < 28) this.mode = 'scale';
      else if (inRect(inflate(this.sel.bounds, 10 / z), p.x, p.y)) this.mode = 'move';
      if (this.mode !== 'none') {
        this.start = { x: p.x, y: p.y };
        this.dx = this.dy = 0;
        this.s = 1;
        this.ed.setHidden(this.sel.ids);
        this.ed.hideSelectionMenu();
        return;
      }
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
      this.dx = p.x - this.start.x;
      this.dy = p.y - this.start.y;
      this.preview();
    } else if (this.mode === 'scale') {
      const b = this.sel!.bounds;
      const s = ((p.x - b.x) * b.w + (p.y - b.y) * b.h) / (b.w * b.w + b.h * b.h || 1);
      this.s = Math.min(8, Math.max(0.1, s));
      this.preview();
    }
    this.ed.requestFrame();
  }

  private preview() {
    const b = this.sel!.bounds;
    for (const id of this.sel!.ids) {
      const o = this.ed.doc.state.objects.get(id);
      if (o?.kind !== 'text' && o?.kind !== 'sticky') continue;
      const pv = this.ed.pageView(o.page)!;
      this.ed.text.preview(id, this.dx, this.dy, this.s, b.x - pv.x - o.x, b.y - pv.y - o.y);
    }
  }

  up(p: Sample) {
    this.move([p]);
    const mode = this.mode;
    this.mode = 'none';
    if (mode === 'lasso') {
      let len = 0;
      for (let i = 1; i < this.poly.length; i++) len += Math.hypot(this.poly[i].x - this.poly[i - 1].x, this.poly[i].y - this.poly[i - 1].y);
      if (len * this.ed.cam.z < 8) this.selectAt(p);
      else this.selectPoly(this.poly);
      this.poly = [];
    } else if (mode === 'move' || mode === 'scale') {
      this.ed.setHidden([]);
      this.ed.text.clearPreview();
      const moved = mode === 'move' ? Math.hypot(this.dx, this.dy) * this.ed.cam.z > 1 : Math.abs(this.s - 1) > 0.005;
      if (moved) this.commitTransform();
      this.dx = this.dy = 0;
      this.s = 1;
      this.refresh();
    }
    this.ed.requestFrame();
  }

  cancel() {
    if (this.mode === 'move' || this.mode === 'scale') { this.ed.setHidden([]); this.ed.text.clearPreview(); }
    this.mode = 'none';
    this.dx = this.dy = 0;
    this.s = 1;
    this.poly = [];
    this.ed.requestFrame();
  }

  deactivate() { this.cancel(); this.clear(); }

  private commitTransform() {
    const sel = this.sel!;
    const b = sel.bounds;
    const ops: Op[] = [];
    const { dx, dy, s } = this;
    for (const id of sel.ids) {
      const o = this.ed.doc.state.objects.get(id);
      if (!o) continue;
      const pv = this.ed.pageView(o.page)!;
      const ax = b.x - pv.x, ay = b.y - pv.y;
      const n = s !== 1
        ? mapObj(o, (x) => ax + (x - ax) * s, (y) => ay + (y - ay) * s, s)
        : mapObj(o, (x) => x + dx, (y) => y + dy, 1);
      // Dropped onto another page? Re-home the object there.
      const nb = objBounds(n);
      const target = this.ed.pageAt(pv.x + nb.x + nb.w / 2, pv.y + nb.y + nb.h / 2, false);
      if (target && target !== pv) {
        const ox = pv.x - target.x, oy = pv.y - target.y;
        const moved = { ...mapObj(n, (x) => x + ox, (y) => y + oy, 1), page: target.page.id };
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

  private selectPoly(poly: Pt[]) {
    if (poly.length < 3) return;
    let pb: Rect | null = null;
    for (const q of poly) pb = union(pb, { x: q.x, y: q.y, w: 0, h: 0 });
    const ids: string[] = [];
    for (const pv of this.ed.pages) {
      if (!intersects(pv.bounds, pb!)) continue;
      for (const o of this.ed.doc.state.objectsOn(pv.page.id)) {
        const b = objBounds(o);
        if (!intersects({ x: b.x + pv.x, y: b.y + pv.y, w: b.w, h: b.h }, pb!)) continue;
        let inside = 0, total = 0;
        if (o.kind === 'stroke') {
          const n = o.pts.length / 3;
          const step = Math.max(1, Math.floor(n / 24));
          for (let i = 0; i < n; i += step) {
            total++;
            if (pointInPolygon(o.pts[i * 3] + pv.x, o.pts[i * 3 + 1] + pv.y, poly)) inside++;
          }
        } else {
          const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h], [b.x + b.w / 2, b.y + b.h / 2]];
          for (const [x, y] of pts) { total++; if (pointInPolygon(x + pv.x, y + pv.y, poly)) inside++; }
        }
        if (total && inside / total >= 0.5) ids.push(o.id);
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
      ctx.fillStyle = 'rgba(217,119,6,0.07)';
      ctx.fill();
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = '#c2620a';
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (!this.sel) return;
    const b = this.sel.bounds;
    const dragging = this.mode === 'move' || this.mode === 'scale';
    const T = (x: number, y: number): Pt =>
      this.mode === 'scale' ? { x: b.x + (x - b.x) * this.s, y: b.y + (y - b.y) * this.s } : { x: x + this.dx, y: y + this.dy };
    if (dragging) {
      for (const o of this.objects()) {
        if (o.kind === 'text' || o.kind === 'sticky') continue;
        const pv = ed.pageView(o.page)!;
        ed.pageTransform(ctx, pv, false);
        const ax = b.x - pv.x, ay = b.y - pv.y;
        if (this.mode === 'scale') { ctx.translate(ax, ay); ctx.scale(this.s, this.s); ctx.translate(-ax, -ay); }
        else ctx.translate(this.dx, this.dy);
        drawObject(ctx, o, { darkPaper: isDark(pv.page.paper) });
      }
    }
    ed.worldTransform(ctx);
    const a = T(b.x, b.y), c = T(b.x + b.w, b.y + b.h);
    const pad = 6 / z;
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = '#c2620a';
    ctx.strokeRect(a.x - pad, a.y - pad, c.x - a.x + 2 * pad, c.y - a.y + 2 * pad);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(c.x + pad, c.y + pad, 7 / z, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2 / z;
    ctx.stroke();
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

