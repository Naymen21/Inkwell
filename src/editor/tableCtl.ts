// Table actions for the editor: insert, edit text, add/delete/move rows and
// columns, resize, move — each one op batch (one undo step) that carries the
// ink written in the table's cells along with them.
import type { LoggedOp, Op, TableObj } from '../model/types';
import { uid } from '../util/ids';
import type { Editor } from './editor';
import { MIN_COL, MIN_ROW, fitRows, moveMap, moved, newTable, relayout } from './table';

export type TableAct = 'rowBelow' | 'colRight' | 'rowUp' | 'rowDown' | 'colLeft' | 'colRight2' | 'delRow' | 'delCol' | 'delete';

export class Tables {
  private pendingFit = new Set<string>();

  constructor(private ed: Editor) {}

  private get(id: string): TableObj | null {
    const o = this.ed.doc.state.objects.get(id);
    return o?.kind === 'table' ? o : null;
  }

  private objs(t: TableObj) { return this.ed.doc.state.objectsOn(t.page); }

  /** Insert a 3×3 table near the middle of the screen and start typing in it. */
  add() {
    const pv = this.ed.currentPage();
    const c = this.ed.screenToWorld(this.ed.viewport.clientWidth / 2, this.ed.viewport.clientHeight / 3);
    const w = Math.min(480, pv.page.w - 72);
    const x = Math.max(36, Math.min(pv.page.w - w - 36, c.x - pv.x - w / 2));
    const y = Math.max(36, Math.min(pv.page.h - 140, c.y - pv.y));
    const t = newTable(uid(), pv.page.id, this.ed.timeline(), x, y, w);
    this.ed.setTool('text');
    this.ed.text.tableFocus = { id: t.id, r: 0, c: 0 };
    this.ed.commitContent([{ t: 'add', obj: t }], pv.page.id);
  }

  /** Save a cell's text and fit the rows to it. */
  setText(id: string, r: number, c: number, text: string) {
    const t = this.get(id);
    if (!t) return;
    const cells = t.cells.map((row) => row.slice());
    cells[r][c] = text;
    const next = { ...t, cells };
    next.rows = fitRows(next, this.objs(t), this.ed.text.measureTable(id));
    this.ed.doc.commit(relayout(t, next, this.objs(t)));
  }

  act(id: string, act: TableAct, r: number, c: number): void {
    const t = this.get(id);
    if (!t) return;
    const R = t.rows.length, C = t.cols.length, objs = this.objs(t);
    let ops: Op[] | null = null;
    const ins = <T>(a: T[], i: number, v: T) => [...a.slice(0, i), v, ...a.slice(i)];
    switch (act) {
      case 'rowBelow': {
        const next = { ...t, rows: ins(t.rows, r + 1, MIN_ROW), cells: ins(t.cells, r + 1, Array(C).fill('')) };
        ops = relayout(t, next, objs, (i) => (i > r ? i + 1 : i));
        this.ed.text.tableFocus = { id, r: r + 1, c };
        break;
      }
      case 'colRight': {
        // Make room for the new column by narrowing the others a little, never below the minimum.
        const w = Math.max(MIN_COL, Math.round(t.w / (C + 1)));
        const next = { ...t, cols: ins(t.cols, c + 1, w), cells: t.cells.map((row) => ins(row, c + 1, '')) };
        ops = relayout(t, next, objs, undefined, (i) => (i > c ? i + 1 : i));
        this.ed.text.tableFocus = { id, r, c: c + 1 };
        break;
      }
      case 'rowUp': case 'rowDown': {
        const to = act === 'rowUp' ? r - 1 : r + 1;
        if (to < 0 || to >= R) return;
        const next = { ...t, rows: moved(t.rows, r, to), cells: moved(t.cells, r, to) };
        ops = relayout(t, next, objs, moveMap(r, to));
        this.ed.text.tableFocus = { id, r: to, c };
        break;
      }
      case 'colLeft': case 'colRight2': {
        const to = act === 'colLeft' ? c - 1 : c + 1;
        if (to < 0 || to >= C) return;
        const next = { ...t, cols: moved(t.cols, c, to), cells: t.cells.map((row) => moved(row, c, to)) };
        ops = relayout(t, next, objs, undefined, moveMap(c, to));
        this.ed.text.tableFocus = { id, r, c: to };
        break;
      }
      case 'delRow': {
        if (R === 1) return this.act(id, 'delete', r, c);
        const next = { ...t, rows: t.rows.filter((_, i) => i !== r), cells: t.cells.filter((_, i) => i !== r) };
        ops = relayout(t, next, objs, (i) => (i === r ? null : i > r ? i - 1 : i));
        this.ed.text.tableFocus = { id, r: Math.min(r, R - 2), c };
        break;
      }
      case 'delCol': {
        if (C === 1) return this.act(id, 'delete', r, c);
        const next = { ...t, cols: t.cols.filter((_, i) => i !== c), cells: t.cells.map((row) => row.filter((_, i) => i !== c)) };
        ops = relayout(t, next, objs, undefined, (i) => (i === c ? null : i > c ? i - 1 : i));
        this.ed.text.tableFocus = { id, r, c: Math.min(c, C - 2) };
        break;
      }
      case 'delete': {
        // The table and the ink written in it go together.
        ops = relayout(t, t, objs, () => null).slice(1);
        ops.push({ t: 'remove', id });
        this.ed.text.tableFocus = null;
        break;
      }
    }
    if (ops) this.ed.doc.commit(ops);
  }

  resizeCol(id: string, c: number, w: number) {
    const t = this.get(id);
    if (!t) return;
    const next = { ...t, cols: t.cols.map((v, i) => (i === c ? w : v)) };
    // Narrower columns wrap text onto more lines; refit after the grid updates.
    this.ed.doc.commit(relayout(t, next, this.objs(t)));
    this.scheduleFit(id);
  }

  move(id: string, dx: number, dy: number) {
    const t = this.get(id);
    if (!t) return;
    const pv = this.ed.pageView(t.page);
    const x = pv ? Math.max(-t.w + 40, Math.min(pv.page.w - 40, t.x + dx)) : t.x + dx;
    const y = pv ? Math.max(0, Math.min(pv.page.h - 40, t.y + dy)) : t.y + dy;
    this.ed.doc.commit(relayout(t, { ...t, x, y }, this.objs(t)));
  }

  /** Refit rows to their content (text and ink). */
  fit(id: string) {
    const t = this.get(id);
    if (!t) return;
    const rows = fitRows(t, this.objs(t), this.ed.text.measureTable(id));
    if (rows.every((h, i) => h === t.rows[i])) return;
    this.ed.doc.commit(relayout(t, { ...t, rows }, this.objs(t)));
  }

  private scheduleFit(id: string) {
    if (this.pendingFit.has(id)) return;
    this.pendingFit.add(id);
    requestAnimationFrame(() => { this.pendingFit.delete(id); this.fit(id); });
  }

  /** Handwriting landed in a table: grow its row to fit. */
  inkChanged(logged: LoggedOp[]) {
    for (const { op } of logged) {
      if (op.t !== 'add' || op.obj.kind !== 'stroke') continue;
      const b = op.obj.bbox, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      for (const o of this.ed.doc.state.objectsOn(op.obj.page)) {
        if (o.kind === 'table' && cx >= o.x && cx <= o.x + o.w && cy >= o.y && cy <= o.y + o.h) this.scheduleFit(o.id);
      }
    }
  }
}
