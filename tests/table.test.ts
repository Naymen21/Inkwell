import { describe, expect, it } from 'vitest';
import { cellAt, fitRows, moveMap, newTable, relayout } from '../src/editor/table';
import { strokeBBox } from '../src/model/doc';
import type { StrokeObj } from '../src/model/types';

const stroke = (id: string, pts: number[]): StrokeObj =>
  ({ kind: 'stroke', id, page: 'p', createdAt: 0, tool: 'pen', color: '#000', opacity: 1, pts, bbox: strokeBBox(pts) } as StrokeObj);

describe('smart tables', () => {
  const t = newTable('t', 'p', 0, 100, 100, 300); // 3x3, cols 100, rows 36

  it('finds the cell under a point', () => {
    expect(cellAt(t, 150, 110)).toEqual({ r: 0, c: 0 });
    expect(cellAt(t, 350, 190)).toEqual({ r: 2, c: 2 });
    expect(cellAt(t, 99, 110)).toBeNull();
  });

  it('grows a row to fit handwriting that spills past it', () => {
    // Ink in row 1 (y 136..172) written down to y 190.
    const s = stroke('s', [150, 140, 2, 160, 190, 2]);
    const rows = fitRows(t, [s], null);
    expect(rows[1]).toBeGreaterThan(60);
    expect(rows[0]).toBe(36);
  });

  it('moves ink in lower rows down when a row grows, and deletes ink with its row', () => {
    const low = stroke('low', [150, 180, 2, 160, 190, 2]); // row 2 (y 172..208)
    const mid = stroke('mid', [150, 145, 2, 160, 155, 2]); // row 1
    const grown = relayout(t, { ...t, rows: [36, 80, 36] }, [low, mid]);
    const lowUpd = grown.find((o) => o.t === 'update' && o.id === 'low') as { patch: StrokeObj };
    expect(lowUpd.patch.pts[1]).toBeCloseTo(224); // shifted by 44
    expect(grown.some((o) => o.t === 'update' && o.id === 'mid')).toBe(false);
    const del = relayout(t, { ...t, rows: [36, 36], cells: t.cells.slice(0, 2) }, [low, mid], (i) => (i === 1 ? null : i > 1 ? i - 1 : i));
    expect(del.some((o) => o.t === 'remove' && o.id === 'mid')).toBe(true);
  });

  it('maps indices when a row moves', () => {
    const m = moveMap(0, 2);
    expect([0, 1, 2].map(m)).toEqual([2, 0, 1]);
    const back = moveMap(2, 0);
    expect([0, 1, 2].map(back)).toEqual([1, 2, 0]);
  });
});
