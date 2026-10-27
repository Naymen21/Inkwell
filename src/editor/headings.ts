// Build an outline for PDFs that don't include one, by spotting headings in
// the PDF's own text: lines set noticeably larger than the body text, or
// lines that read like "Lesson 4" / "Chapter 2". Running headers that repeat
// on many pages (book title, chapter name in the margin) are ignored.

export interface TextLine { page: number; text: string; size: number; y: number }
export interface Heading { page: number; title: string; level: number }

const KEYWORD = /^(chapter|lesson|unit|part|section|module|week|topic|appendix|review)\s+([\divxlc]+|[a-z])\b/i;

export function detectHeadings(lines: TextLine[], pageCount: number): Heading[] {
  const clean = lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text.length >= 2 && l.size > 0);
  if (!clean.length) return [];

  // Body size = the size most characters are set in.
  const bySize = new Map<number, number>();
  for (const l of clean) { const k = Math.round(l.size * 2) / 2; bySize.set(k, (bySize.get(k) ?? 0) + l.text.length); }
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // Text that repeats on many pages is a running header/footer, not a heading.
  const pagesWith = new Map<string, Set<number>>();
  for (const l of clean) {
    const k = l.text.toLowerCase();
    if (!pagesWith.has(k)) pagesWith.set(k, new Set());
    pagesWith.get(k)!.add(l.page);
  }
  const repeated = (t: string) => (pagesWith.get(t.toLowerCase())?.size ?? 0) > Math.max(2, pageCount * 0.3);

  const out: Heading[] = [];
  const perPage = new Map<number, number>();
  for (const l of [...clean].sort((a, b) => a.page - b.page || a.y - b.y)) {
    const t = l.text;
    if (t.length > 90 || !/[a-z]/i.test(t) || /^[\d\s.,:;()-]+$/.test(t)) continue;
    const big = l.size >= body * 1.3;
    const keyword = KEYWORD.test(t) && l.size >= body * 0.95;
    if (!keyword && repeated(t)) continue;
    if (!big && !keyword) continue;
    if ((perPage.get(l.page) ?? 0) >= 3) continue;
    const prev = out[out.length - 1];
    if (prev && prev.title.toLowerCase() === t.toLowerCase()) continue;
    perPage.set(l.page, (perPage.get(l.page) ?? 0) + 1);
    out.push({ page: l.page, title: t, level: keyword || l.size >= body * 1.7 ? 0 : 1 });
    if (out.length >= 300) break;
  }
  // If nothing ranked as a top-level heading, promote everything one level.
  if (out.length && !out.some((h) => h.level === 0)) for (const h of out) h.level = 0;
  return out;
}
