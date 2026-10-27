// One page on screen. Committed content lives in a cached canvas; edits redraw
// only their dirty rectangle. At low zoom the canvas covers the whole page;
// zoomed in, it covers just the visible region plus a margin (a viewport tile),
// which keeps memory bounded on iPad no matter how far you zoom.
import type { Rect } from '../util/geom';
import { contains, intersection, inflate } from '../util/geom';
import type { DocState } from '../model/doc';
import type { Page } from '../model/types';
import { type DrawOpts, drawObjects, drawPaper } from './draw';

/** Max backing pixels per page canvas (iOS Safari caps around 16.7M per canvas). */
const BUDGET = 7_000_000;

export class PageView {
  readonly el: HTMLDivElement;
  readonly textLayer: HTMLDivElement;
  x = 0;
  y = 0;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rendered: { rect: Rect; scale: number } | null = null;
  private dirty: Rect | null = null;

  constructor(public page: Page, private state: () => DocState, private opts: (p: Page) => DrawOpts) {
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.textLayer = document.createElement('div');
    this.textLayer.className = 'text-layer';
    this.el.append(this.textLayer);
  }

  layout(page: Page, x: number, y: number) {
    const resized = page.w !== this.page.w || page.h !== this.page.h;
    this.page = page;
    this.x = x;
    this.y = y;
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${page.w}px`, height: `${page.h}px` });
    if (resized) this.rendered = null;
  }

  get bounds(): Rect { return { x: this.x, y: this.y, w: this.page.w, h: this.page.h }; }

  /**
   * Make sure the visible part of the page is rendered at `scale` device px per pt.
   * `view` is the visible region in page-local coords, or null when off-screen.
   */
  update(view: Rect | null, scale: number, keep: boolean) {
    if (!view) {
      if (!keep) this.release();
      return;
    }
    const full = { x: 0, y: 0, w: this.page.w, h: this.page.h };
    const vis = intersection(view, full);
    if (!vis) { if (!keep) this.release(); return; }
    const r = this.rendered;
    if (r && Math.abs(r.scale - scale) < 1e-3 && contains(r.rect, vis)) return;
    // Partial tiles render at the requested scale; only clamp if even the tile is too big.
    let rect: Rect = full;
    let s = scale;
    if (full.w * full.h * s * s > BUDGET) {
      const m = Math.max(vis.w, vis.h) * 0.5;
      rect = intersection(inflate(vis, m), full)!;
      if (rect.w * rect.h * s * s > BUDGET) s = Math.sqrt(BUDGET / (rect.w * rect.h));
    }
    if (r && Math.abs(r.scale - s) < 1e-3 && contains(r.rect, vis)) return;
    this.renderAll(rect, s);
  }

  private renderAll(rect: Rect, scale: number) {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'page-canvas';
      this.el.prepend(this.canvas);
      this.ctx = this.canvas.getContext('2d', { alpha: false });
    }
    const c = this.canvas;
    const w = Math.max(1, Math.ceil(rect.w * scale)), h = Math.max(1, Math.ceil(rect.h * scale));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    Object.assign(c.style, {
      left: `${rect.x}px`, top: `${rect.y}px`, width: `${w / scale}px`, height: `${h / scale}px`,
    });
    this.rendered = { rect: { x: rect.x, y: rect.y, w: w / scale, h: h / scale }, scale };
    this.dirty = null;
    this.paint(this.rendered.rect);
  }

  invalidate(r: Rect | 'all') {
    if (!this.rendered) return;
    if (r === 'all') r = this.rendered.rect;
    const d = intersection(inflate(r, 1), this.rendered.rect);
    if (!d) return;
    if (!this.dirty) this.dirty = d;
    else {
      const x = Math.min(this.dirty.x, d.x), y = Math.min(this.dirty.y, d.y);
      this.dirty = { x, y, w: Math.max(this.dirty.x + this.dirty.w, d.x + d.w) - x, h: Math.max(this.dirty.y + this.dirty.h, d.y + d.h) - y };
    }
  }

  /** Force a full re-render at the next update (e.g. paper/template changed). */
  reset() { this.rendered = null; }

  flush() {
    if (!this.dirty || !this.rendered) return;
    const R = this.rendered.rect, s = this.rendered.scale;
    const d = this.dirty;
    this.dirty = null;
    // Snap the clip to device pixels so antialiased edges never seam.
    const x0 = Math.floor((d.x - R.x) * s), y0 = Math.floor((d.y - R.y) * s);
    const x1 = Math.ceil((d.x + d.w - R.x) * s), y1 = Math.ceil((d.y + d.h - R.y) * s);
    this.paint({ x: R.x + x0 / s, y: R.y + y0 / s, w: (x1 - x0) / s, h: (y1 - y0) / s });
  }

  private paint(clip: Rect) {
    const ctx = this.ctx!, R = this.rendered!.rect, s = this.rendered!.scale;
    ctx.save();
    ctx.setTransform(s, 0, 0, s, -R.x * s, -R.y * s);
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    drawPaper(ctx, this.page, clip, s);
    drawObjects(ctx, this.state().objectsOn(this.page.id), clip, this.opts(this.page));
    ctx.restore();
  }

  release() {
    if (this.canvas) {
      // Zero-size before dropping: Safari frees canvas memory far sooner this way.
      this.canvas.width = this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this.ctx = null;
    this.rendered = null;
    this.dirty = null;
  }

  destroy() { this.release(); this.el.remove(); }
}
