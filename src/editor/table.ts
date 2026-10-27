// Smart tables: a grid whose rows grow to fit what's in them (typed text or
// handwriting). Ink written in a cell belongs to that cell, so when rows or
// columns are added, removed, moved or resized the ink moves with its cell.
import type { Op, PageObject, StrokeObj, TableObj } from '../model/types';
import { objBounds, strokeBBox } from '../model/doc';

export const MIN_ROW = 36;
export const MIN_COL = 48;

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
/** Left (or top) edge of each column (row), relative to the table. */
export const edges = (sizes: number[]) => sizes.reduce<number[]>((e, s, i) => (e.push(i ? e[i - 1] + sizes[i - 1] : 0), e), []);

export function newTable(id: string, page: string, createdAt: number, x: number, y: number, w: number, rows = 3, cols = 3): TableObj {
  const cw = Math.max(MIN_COL, Math.round(w / cols));
  return {
    kind: 'table', id, page, createdAt, x, y,
    cols: Array(cols).fill(cw), rows: Array(rows).fill(MIN_ROW),
    cells: Array.from({ length: rows }, () => Array(cols).fill('')),
    w: cw * cols, h: MIN_ROW * rows,
  };
}

/** The cell a page point falls in, or null outside the table. */
export function cellAt(t: TableObj, x: number, y: number): { r: number; c: number } | null {
  const lx = x - t.x, ly = y - t.y;
  if (lx < 0 || ly < 0 || lx > t.w || ly > t.h) return null;
  const xs = edges(t.cols), ys = edges(t.rows);
  let c = t.cols.length - 1, r = t.rows.length - 1;
  while (c > 0 && xs[c] > lx) c--;
  while (r > 0 && ys[r] > ly) r--;
  return { r, c };
}

/** Strokes on the page whose center sits inside the table, with their cell. */
export function inkIn(t: TableObj, objs: PageObject[]): { s: StrokeObj; r: number; c: number }[] {
  const out: { s: StrokeObj; r: number; c: number }[] = [];
  for (const o of objs) {
    if (o.kind !== 'stroke') continue;
    const b = o.bbox;
    const cell = cellAt(t, b.x + b.w / 2, b.y + b.h / 2);
    if (cell) out.push({ s: o, ...cell });
  }
  return out;
}

function shift(s: StrokeObj, dx: number, dy: number): Partial<StrokeObj> {
  const pts = s.pts.slice();
  for (let i = 0; i < pts.length; i += 3) { pts[i] = Math.round((pts[i] + dx) * 100) / 100; pts[i + 1] = Math.round((pts[i + 1] + dy) * 100) / 100; }
  return { pts, bbox: strokeBBox(pts) };
}

/**
 * Ops that turn `old` into `next` and carry each cell's ink along.
 * `rowOf` / `colOf` map an old row/column index to its new index (null = deleted;
 * ink in a deleted row or column is deleted with it).
 */
export function relayout(old: TableObj, next: TableObj, objs: PageObject[], rowOf: (r: number) => number | null = (r) => r, colOf: (c: number) => number | null = (c) => c): Op[] {
  next = { ...next, w: sum(next.cols), h: sum(next.rows) };
  const ops: Op[] = [{ t: 'update', id: old.id, patch: { x: next.x, y: next.y, cols: next.cols, rows: next.rows, cells: next.cells, w: next.w, h: next.h } }];
  const ox = edges(old.cols), oy = edges(old.rows), nx = edges(next.cols), ny = edges(next.rows);
  for (const { s, r, c } of inkIn(old, objs)) {
    const r2 = rowOf(r), c2 = colOf(c);
    if (r2 == null || c2 == null) { ops.push({ t: 'remove', id: s.id }); continue; }
    const dx = next.x + nx[c2] - (old.x + ox[c]), dy = next.y + ny[r2] - (old.y + oy[r]);
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) ops.push({ t: 'update', id: s.id, patch: shift(s, dx, dy) });
  }
  return ops;
}

/**
 * Row heights that fit their content: at least MIN_ROW, the typed text's
 * height (`textNeed`, per row, measured by the page) and any ink in the row.
 */
export function fitRows(t: TableObj, objs: PageObject[], textNeed: number[] | null): number[] {
  const ys = edges(t.rows);
  const need = t.rows.map((_, r) => Math.max(MIN_ROW, Math.ceil(textNeed?.[r] ?? 0)));
  for (const { s, r } of inkIn(t, objs)) {
    const b = objBounds(s);
    need[r] = Math.max(need[r], Math.ceil(b.y + b.h - (t.y + ys[r]) + 8));
  }
  return need;
}

/** Move an item of an array from one index to another. */
export function moved<T>(a: T[], from: number, to: number): T[] {
  const b = a.slice();
  const [x] = b.splice(from, 1);
  b.splice(to, 0, x);
  return b;
}

/** Index map for a move: where does old index i end up? */
export function moveMap(from: number, to: number) {
  return (i: number) => (i === from ? to : from < to ? (i > from && i <= to ? i - 1 : i) : (i >= to && i < from ? i + 1 : i));
}

/** All typed text, row by row (for search and Inkly). */
export function tableText(t: TableObj) {
  return t.cells.map((row) => row.join(' | ')).join('\n');
}
