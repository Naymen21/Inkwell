import { describe, expect, it } from 'vitest';
import { detectHeadings, type TextLine } from '../src/editor/headings';

const body = (page: number, n: number, y0 = 200): TextLine[] =>
  Array.from({ length: n }, (_, i) => ({ page, text: 'The Latin root ced means to go or yield; precede means to go before.', size: 11, y: y0 + i * 14 }));

describe('detectHeadings', () => {
  it('finds lesson headings and big titles, skips running headers', () => {
    const lines: TextLine[] = [];
    for (let p = 0; p < 8; p++) {
      lines.push({ page: p, text: 'Vocabulary from Classical Roots', size: 9, y: 20 }); // running header
      if (p % 2 === 0) lines.push({ page: p, text: `Lesson ${p / 2 + 1}`, size: 18, y: 60 });
      if (p === 1) lines.push({ page: p, text: 'Words about Going', size: 15, y: 60 });
      lines.push(...body(p, 20));
      lines.push({ page: p, text: String(p + 1), size: 9, y: 760 }); // page number
    }
    const h = detectHeadings(lines, 8);
    expect(h.map((x) => x.title)).toEqual(['Lesson 1', 'Words about Going', 'Lesson 2', 'Lesson 3', 'Lesson 4']);
    expect(h.find((x) => x.title === 'Lesson 2')).toMatchObject({ page: 2, level: 0 });
    expect(h.find((x) => x.title === 'Words about Going')?.level).toBe(1);
  });

  it('returns nothing for scanned PDFs with no text', () => {
    expect(detectHeadings([], 40)).toEqual([]);
  });
});
