// Canvas drawing of paper and objects, in page coordinates. Used by the page
// canvases, the live overlay, thumbnails and PDF export alike.
import type { Rect } from '../util/geom';
import { intersects, union } from '../util/geom';
import { objBounds } from '../model/doc';
import type { FontKind, Page, PageObject, StickyObj, StrokeObj, TextObj, TableObj } from '../model/types';
import { buildCenterline, buildPen, fromFlat, type InkPoint } from '../ink/stroke';
import { media } from './media';

const pathCache = new WeakMap<StrokeObj, InkPaths>();

/**
 * Paint ink. Highlighter is constant width, so it is one native round-capped
 * stroke: seamless even when translucent. Pen ink is a filled variable-width outline.
 */
export function paintInk(ctx: CanvasRenderingContext2D, pts: InkPoint[], color: string, highlighter: boolean, path?: InkPaths) {
  if (highlighter) {
    const p = path?.edge ?? new Path2D();
    if (!path) buildCenterline(p, pts);
    ctx.strokeStyle = color;
    ctx.lineWidth = pts[0]?.w ?? 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(p);
    return;
  }
  let paths = path;
  if (!paths) { paths = { edge: new Path2D(), core: new Path2D() }; buildPen(paths.edge, paths.core!, pts); }
  ctx.fillStyle = color;
  ctx.fill(paths.edge);
  if (paths.core) ctx.fill(paths.core);
}

export interface InkPaths { edge: Path2D; core?: Path2D }

export function strokePath(o: StrokeObj): InkPaths {
  let p = pathCache.get(o);
  if (!p) {
    if (o.tool === 'highlighter') {
      p = { edge: new Path2D() };
      buildCenterline(p.edge, fromFlat(o.pts));
    } else {
      p = { edge: new Path2D(), core: new Path2D() };
      buildPen(p.edge, p.core!, fromFlat(o.pts));
    }
    pathCache.set(o, p);
  }
  return p;
}

export function isDark(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return false;
  const v = parseInt(m[1], 16);
  const l = 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
  return l < 110;
}

export function drawPaper(ctx: CanvasRenderingContext2D, page: Page, r: Rect, scale: number) {
  ctx.fillStyle = page.paper;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (page.bg) {
    const img = media.image(page.bg);
    if (img) ctx.drawImage(img, 0, 0, page.w, page.h);
  }
  if (page.template === 'blank') return;
  const dark = isDark(page.paper);
  const line = dark ? 'rgba(255,255,255,0.14)' : 'rgba(95,110,140,0.2)';
  const hair = Math.max(0.5 / scale, 0.45);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  if (page.template === 'lined') {
    const step = 26, top = 72;
    ctx.strokeStyle = line;
    ctx.lineWidth = hair;
    ctx.beginPath();
    for (let y = top; y < page.h; y += step) {
      if (y < r.y - 1 || y > r.y + r.h + 1) continue;
      ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y);
    }
    ctx.stroke();
    ctx.strokeStyle = dark ? 'rgba(255,120,120,0.3)' : 'rgba(220,80,80,0.35)';
    ctx.beginPath(); ctx.moveTo(64, r.y); ctx.lineTo(64, r.y + r.h); ctx.stroke();
  } else if (page.template === 'grid') {
    const step = 20;
    ctx.strokeStyle = line;
    ctx.lineWidth = hair;
    ctx.beginPath();
    for (let x = Math.ceil(r.x / step) * step; x <= r.x + r.w; x += step) { ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); }
    for (let y = Math.ceil(r.y / step) * step; y <= r.y + r.h; y += step) { ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); }
    ctx.stroke();
  } else if (page.template === 'dotted') {
    const step = 20, d = 1.1;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(80,90,110,0.34)';
    for (let x = Math.ceil(r.x / step) * step; x <= r.x + r.w; x += step)
      for (let y = Math.ceil(r.y / step) * step; y <= r.y + r.h; y += step) ctx.fillRect(x - d / 2, y - d / 2, d, d);
  }
  ctx.restore();
}

export interface DrawOpts {
  hidden?: Set<string>;
  /** Draw text objects onto the canvas (export/thumbnails); normally text is DOM. */
  text?: boolean;
  /** Playback: objects created after this timeline time are drawn faded. */
  dimAfter?: number | null;
  darkPaper?: boolean;
}

export function drawObject(ctx: CanvasRenderingContext2D, o: PageObject, opts: DrawOpts = {}) {
  const fade = opts.dimAfter != null && o.createdAt > opts.dimAfter ? 0.18 : 1;
  ctx.globalAlpha = fade;
  if (o.kind === 'stroke') {
    ctx.fillStyle = o.color;
    ctx.globalAlpha = o.opacity * fade;
    if (o.tool === 'highlighter' && !opts.darkPaper) ctx.globalCompositeOperation = 'multiply';
    paintInk(ctx, [{ x: 0, y: 0, w: o.pts[2] ?? 1 }], o.color, o.tool === 'highlighter', strokePath(o));
    ctx.globalCompositeOperation = 'source-over';
  } else if (o.kind === 'image') {
    const img = media.image(o.media);
    ctx.save();
    if (o.rot) { ctx.translate(o.x + o.w / 2, o.y + o.h / 2); ctx.rotate(o.rot); ctx.translate(-(o.x + o.w / 2), -(o.y + o.h / 2)); }
    if (img) ctx.drawImage(img, o.x, o.y, o.w, o.h);
    else { ctx.fillStyle = 'rgba(128,128,128,0.15)'; ctx.fillRect(o.x, o.y, o.w, o.h); }
    ctx.restore();
  } else if (o.kind === 'text' && opts.text) {
    drawText(ctx, o);
  } else if (o.kind === 'sticky' && opts.text) {
    drawSticky(ctx, o);
  } else if (o.kind === 'table' && opts.text) {
    drawTable(ctx, o, !!opts.darkPaper);
  }
  ctx.globalAlpha = 1;
}

/** Images, then highlighters, then ink: highlights sit behind writing. */
export function drawObjects(ctx: CanvasRenderingContext2D, objs: PageObject[], clip: Rect | null, opts: DrawOpts) {
  const pass = (o: PageObject) => (o.kind === 'image' ? 0 : o.kind === 'stroke' && o.tool === 'highlighter' ? 1 : 2);
  for (let p = 0; p < 3; p++) {
    for (const o of objs) {
      if (pass(o) !== p || opts.hidden?.has(o.id)) continue;
      if (clip && !intersects(clip, objBounds(o))) continue;
      drawObject(ctx, o, opts);
    }
  }
}

export const FONTS: Record<FontKind, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: '"New York", "Iowan Old Style", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  hand: '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
};

export const TEXT_LINE = 1.3;

export function drawText(ctx: CanvasRenderingContext2D, o: TextObj) {
  ctx.save();
  if (o.rot) { ctx.translate(o.x + o.w / 2, o.y + o.h / 2); ctx.rotate(o.rot); ctx.translate(-(o.x + o.w / 2), -(o.y + o.h / 2)); }
  ctx.fillStyle = o.color;
  ctx.font = `${o.bold ? 'bold ' : ''}${o.size}px ${FONTS[o.font]}`;
  ctx.textBaseline = 'top';
  const lh = o.size * TEXT_LINE;
  let y = o.y + (lh - o.size) / 2;
  for (const para of o.text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && ctx.measureText(test).width > o.w) {
        ctx.fillText(line.trimEnd(), o.x, y);
        y += lh;
        line = w.trimStart();
      } else line = test;
    }
    ctx.fillText(line, o.x, y);
    y += lh;
  }
  ctx.restore();
}

/** Table grid and its typed text (the page shows the same thing as DOM). */
export function drawTable(ctx: CanvasRenderingContext2D, o: TableObj, dark: boolean) {
  ctx.save();
  const line = dark ? 'rgba(255,255,255,0.35)' : 'rgba(60,60,67,0.32)';
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  let y = o.y;
  ctx.font = `15px ${FONTS.sans}`;
  ctx.fillStyle = dark ? '#f2f2f7' : '#1c1c1e';
  ctx.textBaseline = 'top';
  for (let r = 0; r < o.rows.length; r++) {
    let x = o.x;
    for (let c = 0; c < o.cols.length; c++) {
      const w = o.cols[c], h = o.rows[r];
      ctx.strokeRect(x, y, w, h);
      const text = o.cells[r]?.[c] ?? '';
      if (text) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        let ly = y + 7;
        for (const para of text.split('\n')) {
          let cur = '';
          for (const word of para.split(' ')) {
            const t = cur ? `${cur} ${word}` : word;
            if (cur && ctx.measureText(t).width > w - 16) { ctx.fillText(cur, x + 8, ly); ly += 20.25; cur = word; } else cur = t;
          }
          ctx.fillText(cur, x + 8, ly);
          ly += 20.25;
        }
        ctx.restore();
      }
      x += w;
    }
    y += o.rows[r];
  }
  ctx.restore();
}

export function drawSticky(ctx: CanvasRenderingContext2D, o: StickyObj) {
  ctx.save();
  ctx.fillStyle = o.color;
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  if (!o.open) {
    ctx.beginPath();
    ctx.roundRect(o.x, o.y, 30, 30, 6);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    for (let i = 0; i < 3; i++) ctx.fillRect(o.x + 8, o.y + 9 + i * 5, i === 2 ? 9 : 14, 1.6);
  } else {
    ctx.beginPath();
    ctx.roundRect(o.x, o.y, o.w, o.h, 8);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    drawText(ctx, { kind: 'text', id: o.id, page: o.page, createdAt: o.createdAt, x: o.x + 12, y: o.y + 30, w: o.w - 24, h: o.h - 40, text: o.text, size: 13, color: '#2b2b2b', bold: false, font: 'sans' });
  }
  ctx.restore();
}

/** Render a whole page into a fresh canvas (thumbnails, export). */
/**
 * The part of a page worth showing as a picture: the whole page, or for an
 * infinite canvas the area that has something on it (plus a margin).
 */
export function renderBox(page: Page, objs: PageObject[]): Rect {
  if (!page.infinite) return { x: 0, y: 0, w: page.w, h: page.h };
  let b: Rect | null = null;
  for (const o of objs) b = union(b, objBounds(o));
  const cx = b ? b.x + b.w / 2 : page.w / 2, cy = b ? b.y + b.h / 2 : page.h / 2;
  const w = Math.max(612, (b?.w ?? 0) + 96), h = Math.max(400, (b?.h ?? 0) + 96);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** `scale` is device px per pt of the rendered box (see renderBox). */
export function renderPageToCanvas(page: Page, objs: PageObject[], scale: number, background = true): HTMLCanvasElement {
  const box = renderBox(page, objs);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(box.w * scale));
  c.height = Math.max(1, Math.round(box.h * scale));
  const ctx = c.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  drawPaper(ctx, background ? page : { ...page, template: 'blank', paper: '#ffffff' }, box, scale);
  drawObjects(ctx, objs, page.infinite ? box : null, { text: true, darkPaper: isDark(page.paper) });
  return c;
}
