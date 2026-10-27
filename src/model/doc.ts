// The document: an append-only log of timestamped ops plus the materialized
// state derived by folding it. Undo, playback, persistence and (future) sync
// all fall out of this one structure.
import type { Rect } from '../util/geom';
import { union } from '../util/geom';
import { uid } from '../util/ids';
import type { LoggedOp, Op, Page, PageObject, Snapshot } from './types';

export const STICKY_ICON = 30;

export function objBounds(o: PageObject): Rect {
  if (o.kind === 'stroke') return o.bbox;
  if (o.kind === 'sticky' && !o.open) return { x: o.x, y: o.y, w: STICKY_ICON, h: STICKY_ICON };
  const rot = o.kind === 'sticky' ? 0 : o.rot ?? 0;
  if (!rot) return { x: o.x, y: o.y, w: o.w, h: o.h };
  // Rotated box: the axis-aligned box around its four corners.
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2, c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const w = o.w * c + o.h * s, h = o.w * s + o.h * c;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function strokeBBox(pts: number[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, wm = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (pts[i + 2] > wm) wm = pts[i + 2];
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  const r = wm / 2 + 1;
  return { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
}

/** What an apply touched, so the renderer redraws only that. */
export class Change {
  dirty = new Map<string, Rect>();
  layout = false;
  texts = new Set<string>();
  full = new Set<string>();

  mark(page: string, r: Rect) {
    this.dirty.set(page, union(this.dirty.get(page) ?? null, r));
  }
  markObj(o: PageObject) {
    if (o.kind === 'text' || o.kind === 'sticky') this.texts.add(o.id);
    else this.mark(o.page, objBounds(o));
  }
  get empty() {
    return !this.layout && !this.dirty.size && !this.texts.size && !this.full.size;
  }
}

export class DocState {
  pages: Page[] = [];
  objects = new Map<string, PageObject>();
  order = new Map<string, string[]>();

  page(id: string) { return this.pages.find((p) => p.id === id); }
  pageIndex(id: string) { return this.pages.findIndex((p) => p.id === id); }
  objectsOn(page: string): PageObject[] {
    return (this.order.get(page) ?? []).map((id) => this.objects.get(id)!);
  }

  toSnapshot(): Snapshot {
    const objects: Record<string, PageObject[]> = {};
    for (const p of this.pages) objects[p.id] = this.objectsOn(p.id);
    return { pages: this.pages.map((p) => ({ ...p })), objects };
  }

  static fromSnapshot(s: Snapshot): DocState {
    const d = new DocState();
    d.pages = s.pages.map((p) => ({ ...p }));
    for (const p of d.pages) {
      const objs = s.objects[p.id] ?? [];
      d.order.set(p.id, objs.map((o) => o.id));
      for (const o of objs) d.objects.set(o.id, o);
    }
    return d;
  }
}

/** Apply one op in place. Returns the ops that undo it (in apply order). */
export function applyOp(s: DocState, op: Op, ch: Change): Op[] {
  switch (op.t) {
    case 'add': {
      const o = op.obj;
      const list = s.order.get(o.page);
      if (!list || s.objects.has(o.id)) return [];
      s.objects.set(o.id, o);
      const i = op.index == null || op.index > list.length ? list.length : Math.max(0, op.index);
      list.splice(i, 0, o.id);
      ch.markObj(o);
      return [{ t: 'remove', id: o.id }];
    }
    case 'remove': {
      const o = s.objects.get(op.id);
      if (!o) return [];
      const list = s.order.get(o.page)!;
      const i = list.indexOf(o.id);
      list.splice(i, 1);
      s.objects.delete(o.id);
      ch.markObj(o);
      return [{ t: 'add', obj: o, index: i }];
    }
    case 'update': {
      const o = s.objects.get(op.id);
      if (!o) return [];
      const prev: Record<string, unknown> = {};
      const patch = { ...op.patch } as Record<string, unknown>;
      delete patch.id; delete patch.kind; delete patch.page;
      for (const k of Object.keys(patch)) prev[k] = (o as unknown as Record<string, unknown>)[k];
      const n = { ...o, ...patch } as PageObject;
      s.objects.set(o.id, n);
      ch.markObj(o);
      ch.markObj(n);
      return [{ t: 'update', id: o.id, patch: prev as Partial<PageObject> }];
    }
    case 'addPage': {
      if (s.order.has(op.page.id)) return [];
      let i = op.after == null ? 0 : s.pageIndex(op.after) + 1;
      if (op.after != null && i === 0) i = s.pages.length;
      s.pages.splice(i, 0, { ...op.page });
      s.order.set(op.page.id, []);
      ch.layout = true;
      return [{ t: 'removePage', id: op.page.id }];
    }
    case 'removePage': {
      const i = s.pageIndex(op.id);
      if (i < 0) return [];
      const page = s.pages[i];
      const objs = s.objectsOn(page.id);
      for (const o of objs) {
        s.objects.delete(o.id);
        if (o.kind === 'text' || o.kind === 'sticky') ch.texts.add(o.id);
      }
      s.pages.splice(i, 1);
      s.order.delete(page.id);
      ch.layout = true;
      const after = i > 0 ? s.pages[i - 1].id : null;
      return [{ t: 'addPage', page, after }, ...objs.map((obj, index): Op => ({ t: 'add', obj, index }))];
    }
    case 'updatePage': {
      const i = s.pageIndex(op.id);
      if (i < 0) return [];
      const p = s.pages[i];
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(op.patch)) prev[k] = (p as unknown as Record<string, unknown>)[k];
      s.pages[i] = { ...p, ...op.patch, id: p.id };
      if (op.patch.w != null || op.patch.h != null) ch.layout = true;
      ch.full.add(p.id);
      return [{ t: 'updatePage', id: p.id, patch: prev as Partial<Page> }];
    }
  }
}

export function opOrder(a: LoggedOp, b: LoggedOp): number {
  return a.lamport - b.lamport || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);
}

/** Fold a log (optionally on top of a snapshot) into state. Deterministic for any input order. */
export function materialize(log: LoggedOp[], base?: Snapshot): DocState {
  const s = base ? DocState.fromSnapshot(base) : new DocState();
  const ch = new Change();
  for (const e of [...log].sort(opOrder)) applyOp(s, e.op, ch);
  return s;
}

export type DocListener = (ch: Change, logged: LoggedOp[]) => void;

export class NoteDocument {
  state: DocState;
  lamport: number;
  /** Supplies the timeline position stamped on each op (seconds). */
  clock: () => number = () => 0;
  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private txn: Op[] | null = null;
  private listeners = new Set<DocListener>();

  constructor(readonly device: string, state = new DocState(), lamport = 0) {
    this.state = state;
    this.lamport = lamport;
  }

  on(fn: DocListener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Apply ops; listeners are notified via the returned callback once undo state is final. */
  private run(ops: Op[]): [Op[], () => void] {
    const ch = new Change();
    const logged: LoggedOp[] = [];
    let inverse: Op[] = [];
    const ts = this.clock();
    for (const op of ops) {
      const inv = applyOp(this.state, op, ch);
      if (!inv.length) continue; // no-op (target missing); don't log it
      inverse = [...inv, ...inverse];
      logged.push({ id: uid(), op, ts, lamport: ++this.lamport, device: this.device });
    }
    const notify = () => { if (logged.length || !ch.empty) for (const l of this.listeners) l(ch, logged); };
    return [inverse, notify];
  }

  /** Apply ops as one undo step (or as part of an open transaction). */
  commit(ops: Op[]) {
    if (!ops.length) return;
    const [inv, notify] = this.run(ops);
    if (inv.length) {
      if (this.txn) this.txn = [...inv, ...this.txn];
      else this.undoStack.push(inv);
      this.redoStack = [];
      if (this.undoStack.length > 300) this.undoStack.shift();
    }
    notify();
  }

  /** Group many commits (e.g. one eraser drag) into a single undo step. */
  begin() { if (!this.txn) this.txn = []; }
  end() {
    const t = this.txn;
    this.txn = null;
    if (t && t.length) {
      this.undoStack.push(t);
      this.redoStack = [];
      for (const l of this.listeners) l(new Change(), []); // refresh undo UI
    }
  }

  // Undo emits compensating ops rather than truncating the log, so the
  // history stays append-only and other devices would converge on it.
  undo() {
    this.end();
    const e = this.undoStack.pop();
    if (!e) return;
    const [inv, notify] = this.run(e);
    this.redoStack.push(inv);
    notify();
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    const [inv, notify] = this.run(e);
    this.undoStack.push(inv);
    notify();
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** Merge ops from elsewhere (import / future sync): union, re-sort, re-materialize. */
  merge(remote: LoggedOp[], base: Snapshot, local: LoggedOp[]) {
    const seen = new Set<string>();
    const all = [...local, ...remote].filter((e) => !seen.has(e.id) && (seen.add(e.id), true));
    this.state = materialize(all, base);
    for (const e of all) this.lamport = Math.max(this.lamport, e.lamport);
    const ch = new Change();
    ch.layout = true;
    for (const p of this.state.pages) ch.full.add(p.id);
    for (const l of this.listeners) l(ch, []);
  }
}
