// Import/export: PDF in (pages become backgrounds you annotate on top of),
// PDF out (flattened), and a portable .inkwell file for moving notes between
// devices.
import type { Clip, NoteMeta, OutlineEntry, Page, Snapshot } from '../model/types';
import { DocState, materialize } from '../model/doc';
import { db } from '../persist/db';
import { media } from '../render/media';
import { renderPageToCanvas } from '../render/draw';
import { uid } from '../util/ids';
import { inClaude, useCapability } from '../util/claude';

async function loadPdfjs() {
  const [lib, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
}

/** Rasterize each PDF page into the media store and return pages that use them as backgrounds. */
export async function pdfToPages(file: Blob, progress: (done: number, total: number) => void): Promise<{ pages: Page[]; outline: OutlineEntry[] }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const pages: Page[] = [];
  const outline: OutlineEntry[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      progress(i - 1, pdf.numPages);
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // ~2.4x keeps text crisp when zoomed while staying inside iPad canvas limits.
      const scale = Math.min(2.4, Math.sqrt(9_000_000 / (base.width * base.height)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, viewport: vp }).promise;
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.9));
      canvas.width = canvas.height = 0;
      const hash = await db.putMedia(blob);
      pages.push({ id: uid(), w: Math.round(base.width), h: Math.round(base.height), template: 'blank', paper: '#ffffff', bg: hash });
      page.cleanup();
    }
    // The PDF's own table of contents becomes jump links in the pages panel.
    try {
      type Item = { title?: string; dest?: unknown; items?: Item[] };
      const doc = pdf as unknown as {
        getOutline(): Promise<Item[] | null>;
        getDestination(id: string): Promise<unknown[] | null>;
        getPageIndex(ref: unknown): Promise<number>;
      };
      const walk = async (list: Item[], level: number) => {
        for (const it of list) {
          if (outline.length >= 500) return;
          let dest = it.dest;
          if (typeof dest === 'string') dest = await doc.getDestination(dest).catch(() => null);
          let idx = -1;
          if (Array.isArray(dest) && dest[0] != null) {
            idx = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]).catch(() => -1);
          }
          if (idx >= 0 && pages[idx]) outline.push({ title: String(it.title ?? '').trim() || 'Untitled section', page: pages[idx].id, level });
          if (it.items?.length) await walk(it.items, level + 1);
        }
      };
      await walk((await doc.getOutline()) ?? [], 0);
    } catch { /* PDF has no usable outline */ }
  } finally {
    progress(pdf.numPages, pdf.numPages);
    task.destroy();
  }
  return { pages, outline };
}

async function preloadMedia(state: DocState) {
  const hashes = new Set<string>();
  for (const p of state.pages) if (p.bg) hashes.add(p.bg);
  for (const o of state.objects.values()) if (o.kind === 'image') hashes.add(o.media);
  await Promise.all([...hashes].map((h) => media.ready(h)));
}

export interface ExportOpts { background?: boolean; pageIds?: string[] }

export async function exportPdf(title: string, state: DocState, progress: (d: number, t: number) => void, opts: ExportOpts = {}): Promise<Blob> {
  await preloadMedia(state);
  const { jsPDF } = await import('jspdf');
  // Skip a trailing blank page (the notebook always keeps one).
  let pages = state.pages.filter((p, i) => i < state.pages.length - 1 || state.objectsOn(p.id).length || p.bg || state.pages.length === 1);
  if (opts.pageIds) pages = state.pages.filter((p) => opts.pageIds!.includes(p.id));
  let pdf: InstanceType<typeof jsPDF> | null = null;
  for (let i = 0; i < pages.length; i++) {
    progress(i, pages.length);
    const p = pages[i];
    const orient = p.w > p.h ? 'landscape' : 'portrait';
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [p.w, p.h], orientation: orient, compress: true });
    else pdf.addPage([p.w, p.h], orient);
    const c = renderPageToCanvas(p, state.objectsOn(p.id), 2.5, opts.background !== false);
    pdf.addImage(c, 'JPEG', 0, 0, p.w, p.h, undefined, 'FAST');
    c.width = c.height = 0;
    await new Promise((r) => setTimeout(r));
  }
  pdf!.setProperties({ title });
  return pdf!.output('blob');
}

// ---------------------------------------------------------------- .inkwell files

interface NoteFile {
  format: 'inkwell';
  version: 1;
  title: string;
  created: number;
  clips: Clip[];
  snapshot: Snapshot;
  media: Record<string, string>;
  audio: Record<string, string>;
}

const toDataUrl = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result as string);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

export async function exportNoteFile(meta: NoteMeta): Promise<Blob> {
  const { snap, ops } = await db.loadDoc(meta.id);
  const state = materialize(ops, snap?.state);
  const file: NoteFile = {
    format: 'inkwell', version: 1, title: meta.title, created: meta.created, clips: meta.clips,
    snapshot: state.toSnapshot(), media: {}, audio: {},
  };
  const hashes = new Set<string>();
  for (const p of state.pages) if (p.bg) hashes.add(p.bg);
  for (const o of state.objects.values()) if (o.kind === 'image') hashes.add(o.media);
  for (const h of hashes) { const b = await db.getMedia(h); if (b) file.media[h] = await toDataUrl(b); }
  for (const c of meta.clips) { const a = await db.getAudio(c.id); if (a) file.audio[c.id] = await toDataUrl(a.blob); }
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

export async function importNoteFile(blob: Blob, folder: string | null): Promise<NoteMeta> {
  const f = JSON.parse(await blob.text()) as NoteFile;
  if (f.format !== 'inkwell' || !f.snapshot?.pages) throw new Error('Not an Inkwell note');
  const remap = new Map<string, string>();
  for (const [h, url] of Object.entries(f.media)) remap.set(h, await db.putMedia(await (await fetch(url)).blob()));
  const snap = f.snapshot;
  for (const p of snap.pages) if (p.bg) p.bg = remap.get(p.bg) ?? p.bg;
  for (const list of Object.values(snap.objects)) for (const o of list) if (o.kind === 'image') o.media = remap.get(o.media) ?? o.media;
  const id = uid();
  const clips: Clip[] = [];
  for (const c of f.clips ?? []) {
    const url = f.audio[c.id];
    if (!url) continue;
    const nc = { ...c, id: uid() };
    await db.putAudio({ id: nc.id, note: id, blob: await (await fetch(url)).blob() });
    clips.push(nc);
  }
  const now = Date.now();
  const meta: NoteMeta = { id, title: f.title || 'Imported note', folder, created: f.created || now, modified: now, clips, pageCount: snap.pages.length };
  await db.putSnapshot(id, snap, 0);
  await db.putNote(meta);
  return meta;
}

type Downloads = { save(r: { filename: string; data: Blob }): Promise<unknown> };

export async function saveBlob(blob: Blob, name: string) {
  // Inside Claude the frame can't download directly; the viewer confirms each save.
  if (inClaude) {
    const dl = await useCapability<Downloads>('downloads');
    if (!dl) throw new Error('Saving files is not available here');
    const filename = name.endsWith('.inkwell') ? `${name}.json` : name;
    try { await dl.save({ filename, data: blob }); }
    catch (e) { if ((e as { code?: string }).code !== 'declined') throw e; }
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export const safeName = (s: string) => (s.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'note').slice(0, 80);
