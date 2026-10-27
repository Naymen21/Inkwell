import { describe, expect, it } from 'vitest';
import { pageOffset, parseJson } from '../src/editor/aiOutline';

describe('scanned table of contents helpers', () => {
  it('works out how printed page numbers map to PDF pages', () => {
    // PDF pages 1-4 are front matter (roman numerals / none); printed page 1 is PDF page 5.
    expect(pageOffset({ '1': null, '2': 'iii', '3': 'iv', '5': 1, '6': 2, '7': '3', '8': 9 })).toBe(4);
    expect(pageOffset({ '1': null, '2': 'ii' })).toBeNull();
  });

  it('reads JSON wrapped in prose or a code fence', () => {
    expect(parseJson<{ a: number }>('Sure! ```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson<{ a: number }>('Here you go: {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(parseJson('no json here')).toBeNull();
  });
});
