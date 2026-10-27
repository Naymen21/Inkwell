import { describe, expect, it } from 'vitest';
import { Change, DocState, NoteDocument, applyOp, materialize, strokeBBox } from '../src/model/doc';
import type { LoggedOp, Page, StrokeObj } from '../src/model/types';

const page = (id: string): Page => ({ id, w: 612, h: 792, template: 'blank', paper: '#fff' });
const stroke = (id: string, pg: string, x = 10): StrokeObj => {
  const pts = [x, 10, 2, x + 50, 60, 2];
  return { kind: 'stroke', id, page: pg, createdAt: 0, tool: 'pen', color: '#000', opacity: 1, pts, bbox: strokeBBox(pts) };
};

function newDoc(device = 'A') {
  const d = new NoteDocument(device);
  const log: LoggedOp[] = [];
  d.on((_c, l) => log.push(...l));
  return { d, log };
}

describe('document model', () => {
  it('adds, removes and undoes', () => {
    const { d } = newDoc();
    d.commit([{ t: 'addPage', page: page('p1'), after: null }]);
    d.commit([{ t: 'add', obj: stroke('s1', 'p1') }]);
    d.commit([{ t: 'add', obj: stroke('s2', 'p1') }]);
    expect(d.state.order.get('p1')).toEqual(['s1', 's2']);
    d.commit([{ t: 'remove', id: 's1' }]);
    expect(d.state.order.get('p1')).toEqual(['s2']);
    d.undo();
    expect(d.state.order.get('p1')).toEqual(['s1', 's2']); // z-order restored
    d.undo();
    expect(d.state.order.get('p1')).toEqual(['s1']);
    d.redo();
    expect(d.state.order.get('p1')).toEqual(['s1', 's2']);
  });

  it('undo of removePage restores its objects', () => {
    const { d } = newDoc();
    d.commit([{ t: 'addPage', page: page('p1'), after: null }, { t: 'addPage', page: page('p2'), after: 'p1' }]);
    d.commit([{ t: 'add', obj: stroke('a', 'p2') }, { t: 'add', obj: stroke('b', 'p2') }]);
    d.commit([{ t: 'removePage', id: 'p2' }]);
    expect(d.state.pages.map((p) => p.id)).toEqual(['p1']);
    expect(d.state.objects.size).toBe(0);
    d.undo();
    expect(d.state.pages.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(d.state.order.get('p2')).toEqual(['a', 'b']);
  });

  it('transactions group into one undo step', () => {
    const { d } = newDoc();
    d.commit([{ t: 'addPage', page: page('p1'), after: null }]);
    d.commit([{ t: 'add', obj: stroke('a', 'p1') }, { t: 'add', obj: stroke('b', 'p1') }]);
    d.begin();
    d.commit([{ t: 'remove', id: 'a' }]);
    d.commit([{ t: 'remove', id: 'b' }]);
    d.end();
    expect(d.state.objects.size).toBe(0);
    d.undo();
    expect(d.state.order.get('p1')).toEqual(['a', 'b']);
  });

  it('update records prior values and undoes', () => {
    const { d } = newDoc();
    d.commit([{ t: 'addPage', page: page('p1'), after: null }]);
    d.commit([{ t: 'add', obj: stroke('a', 'p1') }]);
    d.commit([{ t: 'update', id: 'a', patch: { color: '#f00' } }]);
    expect((d.state.objects.get('a') as StrokeObj).color).toBe('#f00');
    d.undo();
    expect((d.state.objects.get('a') as StrokeObj).color).toBe('#000');
  });

  it('replaying the log reproduces state, undo included', () => {
    const { d, log } = newDoc();
    d.commit([{ t: 'addPage', page: page('p1'), after: null }]);
    d.commit([{ t: 'add', obj: stroke('a', 'p1') }]);
    d.commit([{ t: 'add', obj: stroke('b', 'p1', 100) }]);
    d.commit([{ t: 'update', id: 'b', patch: { color: '#00f' } }]);
    d.undo();
    d.commit([{ t: 'remove', id: 'a' }]);
    const replay = materialize([...log].reverse());
    expect(replay.toSnapshot()).toEqual(d.state.toSnapshot());
  });

  it('snapshot + tail replay equals full replay', () => {
    const { d, log } = newDoc();
    d.commit([{ t: 'addPage', page: page('p1'), after: null }]);
    d.commit([{ t: 'add', obj: stroke('a', 'p1') }]);
    const snap = d.state.toSnapshot();
    const mark = d.lamport;
    d.commit([{ t: 'add', obj: stroke('b', 'p1') }]);
    d.commit([{ t: 'remove', id: 'a' }]);
    const tail = log.filter((e) => e.lamport > mark);
    expect(materialize(tail, snap).toSnapshot()).toEqual(d.state.toSnapshot());
  });

  it('concurrent devices converge regardless of arrival order', () => {
    const base = newDoc('A');
    base.d.commit([{ t: 'addPage', page: page('p1'), after: null }]);
    const shared = [...base.log];
    const A = newDoc('A'), B = newDoc('B');
    A.d.state = materialize(shared); A.d.lamport = base.d.lamport;
    B.d.state = materialize(shared); B.d.lamport = base.d.lamport;
    A.d.commit([{ t: 'add', obj: stroke('a1', 'p1') }]);
    B.d.commit([{ t: 'add', obj: stroke('b1', 'p1') }]);
    B.d.commit([{ t: 'remove', id: 'b1' }]);
    A.d.commit([{ t: 'add', obj: stroke('a2', 'p1') }]);
    const all = [...shared, ...A.log, ...B.log];
    const s1 = materialize(all).toSnapshot();
    const s2 = materialize([...all].reverse()).toSnapshot();
    expect(s1).toEqual(s2);
    expect(s1.objects.p1.map((o) => o.id).sort()).toEqual(['a1', 'a2']);
  });

  it('ops on missing targets are ignored', () => {
    const s = new DocState();
    const ch = new Change();
    expect(applyOp(s, { t: 'remove', id: 'nope' }, ch)).toEqual([]);
    expect(applyOp(s, { t: 'add', obj: stroke('x', 'nopage') }, ch)).toEqual([]);
  });
});
