// Table of contents for scanned PDFs. Scanned pages are only pictures, so the
// PDF's text can't be read; instead Inkly looks at the first pages, finds the
// table-of-contents page(s), reads each entry with its printed page number,
// and reads the page numbers printed on the pages so "p. 21" can be mapped to
// the right PDF page even when the book has front matter before page 1.
import type { OutlineEntry, Page } from '../model/types';
import { media } from '../render/media';
import { Credits } from './credits';
import { getSample } from './inkly';
import { settings } from './settings';

const FIRST = 8; // pages examined for the table of contents

interface Found { entries?: { title?: string; page?: number | string | null; level?: number }[]; printed?: Record<string, number | string | null> }

/** One page as a JPEG Inkly can read (scanned text needs more pixels than handwriting). */
async function pageJpeg(p: Page, pixels: number): Promise<Blob | null> {
  if (!p.bg) return null;
  const img = await media.ready(p.bg);
  if (!img) return null;
  const s = Math.sqrt(pixels / (p.w * p.h));
  const c = document.createElement('canvas');
  c.width = Math.round(p.w * s);
  c.height = Math.round(p.h * s);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.82));
  c.width = c.height = 0;
  return blob;
}

/** Tolerant JSON: the whole reply, a fenced block, or the outermost {...}. */
export function parseJson<T>(text: string): T | null {
  const tries = [text, /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? '', text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const t of tries) { try { if (t.trim()) return JSON.parse(t) as T; } catch { /* next */ } }
  return null;
}

/**
 * Printed page number → PDF page offset, from pages whose printed number
 * was read: the most common (pdfPage − printed). Roman numerals are ignored.
 */
export function pageOffset(printed: Record<string, number | string | null>): number | null {
  const votes = new Map<number, number>();
  for (const [k, v] of Object.entries(printed)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
    const pdf = Number(k);
    if (!Number.isFinite(n) || !Number.isFinite(pdf)) continue;
    votes.set(pdf - n, (votes.get(pdf - n) ?? 0) + 1);
  }
  let best: number | null = null, count = 0;
  for (const [off, c] of votes) if (c > count) { best = off; count = c; }
  return best;
}

export type AiOutlineResult = { entries: OutlineEntry[]; problem?: string };

export async function findOutlineWithAI(pages: Page[], status: (s: string) => void): Promise<AiOutlineResult> {
  const ai = await getSample();
  if (!ai) return { entries: [], problem: 'Inkly isn’t available here, so the scanned table of contents can’t be read.' };
  const metered = ai.provider !== 'Claude';
  const credits = new Credits(() => settings.inklyDailyCredits);
  if (metered && credits.blockedUntil()) return { entries: [], problem: 'You’re out of Inkly credits for today.' };
  const ask = async (prompt: string, imgs: Blob[]) => {
    const { text } = await ai([{ role: 'user', content: prompt }], { images: imgs, cache: false, ...(metered ? { speed: 'quality' } : {}) });
    if (metered) credits.spend();
    return parseJson<Found>(text);
  };

  const limit = Math.min(FIRST, (await ai.limits().catch(() => null))?.images?.maxCount ?? FIRST);
  if (limit < 1) return { entries: [], problem: 'Inkly can’t look at images here, so the scanned table of contents can’t be read.' };
  const first = pages.slice(0, limit).filter((p) => p.bg);
  if (!first.length) return { entries: [], problem: 'This note has no PDF pages to read.' };
  status('Reading the table of contents…');
  const imgs = (await Promise.all(first.map((p) => pageJpeg(p, 1_200_000)))).filter((b): b is Blob => !!b);
  const labels = first.map((p) => pages.indexOf(p) + 1);
  const found = await ask(
    `These images are pages of a scanned book or handout, in order. They are PDF pages ${labels.join(', ')}.\n` +
    '1. Find the table of contents (it may span several pages).\n' +
    '2. List every entry exactly as written, with the page number printed next to it. Use level 0 for units, chapters or lessons and level 1 for sections inside them.\n' +
    '3. For each image, give the page number printed on that page itself (header or footer), or null if there is none.\n' +
    'Reply with only JSON: {"entries":[{"title":"Lesson 1: Ced","page":5,"level":0}],"printed":{"' + labels[0] + '":null}}\n' +
    'The keys of "printed" are the PDF page numbers listed above. If there is no table of contents, "entries" is [].',
    imgs,
  );
  const raw = (found?.entries ?? []).filter((e) => e && typeof e.title === 'string' && e.title.trim());
  if (!raw.length) return { entries: [], problem: 'Inkly didn’t find a table of contents in the first pages.' };

  // Line printed page numbers up with PDF pages; look further in if the first pages are all front matter.
  let offset = pageOffset(found?.printed ?? {});
  if (offset == null && pages.length > limit) {
    status('Matching page numbers…');
    const later = [12, 20, 32, 48].map((i) => Math.min(pages.length - 1, i)).filter((i, k, a) => i >= limit && a.indexOf(i) === k).slice(0, limit).map((i) => pages[i]);
    const more = (await Promise.all(later.map((p) => pageJpeg(p, 700_000)))).filter((b): b is Blob => !!b);
    const ls = later.map((p) => pages.indexOf(p) + 1);
    const nums = await ask(
      `These images are PDF pages ${ls.join(', ')} of a scanned book, in order. For each, give the page number printed on the page (header or footer), or null.\n` +
      'Reply with only JSON: {"printed":{"' + ls[0] + '":12}}',
      more,
    );
    offset = pageOffset(nums?.printed ?? {});
  }
  const off = offset ?? 0;
  const entries: OutlineEntry[] = [];
  for (const e of raw) {
    const n = typeof e.page === 'number' ? e.page : Number(String(e.page ?? '').replace(/[^\d]/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    const idx = Math.min(pages.length, Math.max(1, n + off)) - 1;
    entries.push({ title: e.title!.trim().slice(0, 120), page: pages[idx].id, level: e.level === 1 ? 1 : 0 });
  }
  if (!entries.length) return { entries: [], problem: 'Inkly read the table of contents but couldn’t match its page numbers.' };
  return { entries };
}
