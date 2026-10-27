// IndexedDB persistence. Each committed op is appended in its own transaction
// (the web's fsync), snapshots bound load time, media is content-addressed.
import type { Folder, LoggedOp, NoteMeta, Snapshot } from '../model/types';
import { hashBytes } from '../util/ids';

interface OpRow extends LoggedOp { note: string }
interface SnapRow { note: string; state: Snapshot; lamport: number }
interface MediaRow { hash: string; blob: Blob }
export interface AudioRow { id: string; note: string; blob: Blob }
interface ChunkRow { clip: string; i: number; note: string; blob: Blob; mime: string; start: number; startedAt: number }

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('This browser has storage turned off.');
      req = indexedDB.open('inkwell', 1);
    } catch (e) {
      reject(e instanceof Error && /security|denied|turned off/i.test(e.message) ? new Error('This browser is blocking on-device storage.') : e);
      return;
    }
    // Safari can leave an open request hanging; don't wait forever.
    const timer = setTimeout(() => reject(new Error('On-device storage didn’t respond. Reload and try again.')), 6000);
    req.onblocked = () => reject(new Error('Inkwell is open in another tab with an older version. Close other Inkwell tabs.'));
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('notes', { keyPath: 'id' });
      db.createObjectStore('folders', { keyPath: 'id' });
      db.createObjectStore('ops', { keyPath: ['note', 'lamport', 'device'] });
      db.createObjectStore('snapshots', { keyPath: 'note' });
      db.createObjectStore('media', { keyPath: 'hash' });
      db.createObjectStore('audio', { keyPath: 'id' }).createIndex('note', 'note');
      db.createObjectStore('chunks', { keyPath: ['clip', 'i'] }).createIndex('note', 'note');
    };
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error ?? new Error('This browser is blocking on-device storage.')); };
  });
  // Let a later call retry instead of reusing a failure.
  dbp.catch(() => { dbp = null; });
  return dbp;
}

function wrap<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error('transaction aborted'));
  });
  const out = await fn(t);
  await done;
  return out;
}

const opRange = (note: string, after = -1) =>
  IDBKeyRange.bound([note, after, ''], [note, Infinity, '￿'], true, false);

export const db = {
  async listNotes(): Promise<NoteMeta[]> {
    return tx(['notes'], 'readonly', (t) => wrap(t.objectStore('notes').getAll()));
  },
  async getNote(id: string): Promise<NoteMeta | undefined> {
    return tx(['notes'], 'readonly', (t) => wrap(t.objectStore('notes').get(id)));
  },
  async putNote(n: NoteMeta) {
    await tx(['notes'], 'readwrite', (t) => { t.objectStore('notes').put(n); });
  },
  async deleteNote(id: string) {
    await tx(['notes', 'ops', 'snapshots', 'audio', 'chunks'], 'readwrite', async (t) => {
      t.objectStore('notes').delete(id);
      t.objectStore('ops').delete(opRange(id));
      t.objectStore('snapshots').delete(id);
      for (const s of ['audio', 'chunks']) {
        const keys = await wrap(t.objectStore(s).index('note').getAllKeys(id));
        for (const k of keys) t.objectStore(s).delete(k);
      }
    });
  },

  async listFolders(): Promise<Folder[]> {
    return tx(['folders'], 'readonly', (t) => wrap(t.objectStore('folders').getAll()));
  },
  async putFolder(f: Folder) {
    await tx(['folders'], 'readwrite', (t) => { t.objectStore('folders').put(f); });
  },
  async deleteFolder(id: string) {
    await tx(['folders'], 'readwrite', (t) => { t.objectStore('folders').delete(id); });
  },

  async appendOps(note: string, ops: LoggedOp[]) {
    if (!ops.length) return;
    await tx(['ops'], 'readwrite', (t) => {
      const s = t.objectStore('ops');
      for (const o of ops) s.put({ ...o, note } satisfies OpRow);
    });
  },
  async putSnapshot(note: string, state: Snapshot, lamport: number) {
    await tx(['snapshots'], 'readwrite', (t) => { t.objectStore('snapshots').put({ note, state, lamport } satisfies SnapRow); });
  },
  /** Snapshot plus only the ops after its watermark: load is O(recent ops). */
  async loadDoc(note: string): Promise<{ snap?: SnapRow; ops: LoggedOp[] }> {
    return tx(['snapshots', 'ops'], 'readonly', async (t) => {
      const snap: SnapRow | undefined = await wrap(t.objectStore('snapshots').get(note));
      const rows: OpRow[] = await wrap(t.objectStore('ops').getAll(opRange(note, snap?.lamport ?? -1)));
      return { snap, ops: rows.map(({ note: _n, ...o }) => o) };
    });
  },
  async allOps(note: string): Promise<LoggedOp[]> {
    const rows: OpRow[] = await tx(['ops'], 'readonly', (t) => wrap(t.objectStore('ops').getAll(opRange(note))));
    return rows.map(({ note: _n, ...o }) => o);
  },

  async putMedia(blob: Blob): Promise<string> {
    const hash = await hashBytes(await blob.arrayBuffer());
    await tx(['media'], 'readwrite', async (t) => {
      const s = t.objectStore('media');
      if (!(await wrap(s.getKey(hash)))) s.put({ hash, blob } satisfies MediaRow);
    });
    return hash;
  },
  async getMedia(hash: string): Promise<Blob | undefined> {
    const r: MediaRow | undefined = await tx(['media'], 'readonly', (t) => wrap(t.objectStore('media').get(hash)));
    return r?.blob;
  },

  async putAudio(row: AudioRow) {
    await tx(['audio'], 'readwrite', (t) => { t.objectStore('audio').put(row); });
  },
  async getAudio(id: string): Promise<AudioRow | undefined> {
    return tx(['audio'], 'readonly', (t) => wrap(t.objectStore('audio').get(id)));
  },
  async deleteAudio(id: string) {
    await tx(['audio'], 'readwrite', (t) => { t.objectStore('audio').delete(id); });
  },

  // Recording chunks are flushed every few seconds so a crash loses seconds, not the lecture.
  async putChunk(row: ChunkRow) {
    await tx(['chunks'], 'readwrite', (t) => { t.objectStore('chunks').put(row); });
  },
  async chunksForNote(note: string): Promise<ChunkRow[]> {
    return tx(['chunks'], 'readonly', (t) => wrap(t.objectStore('chunks').index('note').getAll(note)));
  },
  async deleteChunks(clip: string) {
    await tx(['chunks'], 'readwrite', (t) => {
      t.objectStore('chunks').delete(IDBKeyRange.bound([clip, -Infinity], [clip, Infinity]));
    });
  },
};
