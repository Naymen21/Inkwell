// Audio: recording clips onto the note timeline, and playing the timeline back.
import type { Clip } from '../model/types';
import { db } from '../persist/db';
import { uid } from '../util/ids';

const FLUSH_MS = 4000;

function pickMime(): string {
  const prefs = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined') return '';
  return prefs.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  clip: Clip | null = null;

  get active() { return !!this.rec; }
  elapsed() { return this.rec ? (performance.now() - this.startedAt) / 1000 : 0; }

  static supported() {
    // claude.ai frames refuse the microphone, so recording is a standalone-app feature.
    if ('claude' in window) return false;
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(note: string, timelineStart: number) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = pickMime();
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const clip: Clip = { id: uid(), start: timelineStart, duration: 0, mime: rec.mimeType || mime || 'audio/webm' };
    this.chunks = [];
    let i = 0;
    const wall = Date.now();
    // Each slice is flushed to IndexedDB right away; a crash loses at most one slice.
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.chunks.push(e.data);
      db.putChunk({ clip: clip.id, i: i++, note, blob: e.data, mime: clip.mime, start: timelineStart, startedAt: wall })
        .catch((err) => console.warn('chunk flush failed', err));
    };
    rec.start(FLUSH_MS);
    this.rec = rec;
    this.clip = clip;
    this.startedAt = performance.now();
  }

  /** Stop and return the finished clip with its audio. */
  stop(): Promise<{ clip: Clip; blob: Blob } | null> {
    const rec = this.rec, clip = this.clip;
    if (!rec || !clip) return Promise.resolve(null);
    clip.duration = this.elapsed();
    this.rec = null;
    this.clip = null;
    return new Promise((resolve) => {
      rec.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        resolve({ clip, blob: new Blob(this.chunks, { type: clip.mime }) });
      };
      rec.stop();
    });
  }
}

/** Rebuild clips whose recording was interrupted (tab closed / crash) from flushed chunks. */
export async function recoverClips(note: string, known: Clip[]): Promise<Clip[]> {
  const rows = await db.chunksForNote(note);
  const byClip = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byClip.has(r.clip)) byClip.set(r.clip, []);
    byClip.get(r.clip)!.push(r);
  }
  const out: Clip[] = [];
  for (const [id, list] of byClip) {
    if (known.some((c) => c.id === id)) { await db.deleteChunks(id); continue; }
    list.sort((a, b) => a.i - b.i);
    const blob = new Blob(list.map((r) => r.blob), { type: list[0].mime });
    const duration = (await probeDuration(blob)) ?? list.length * (FLUSH_MS / 1000);
    const clip: Clip = { id, start: list[0].start, duration, mime: list[0].mime };
    await db.putAudio({ id, note, blob });
    await db.deleteChunks(id);
    out.push(clip);
  }
  return out;
}

function probeDuration(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 3000);
    a.src = url;
  });
}

export function timelineEnd(clips: Clip[]) {
  return clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
}

/** Plays the clip sequence as one continuous timeline. */
export class Player {
  private audio = new Audio();
  private urls = new Map<string, string>();
  private idx = -1;
  private raf = 0;
  playing = false;
  t = 0;
  rate = 1;
  onTime: (t: number) => void = () => {};
  onState: () => void = () => {};

  constructor(public clips: Clip[]) {
    this.audio.preload = 'auto';
    this.audio.onended = () => this.next();
  }

  get duration() { return timelineEnd(this.clips); }

  private clipAt(t: number) {
    const sorted = [...this.clips].sort((a, b) => a.start - b.start);
    let i = sorted.findIndex((c) => t >= c.start && t < c.start + c.duration);
    if (i < 0) i = sorted.findIndex((c) => c.start > t);
    return i < 0 ? null : sorted[i];
  }

  private async url(clip: Clip) {
    let u = this.urls.get(clip.id);
    if (!u) {
      const row = await db.getAudio(clip.id);
      if (!row) return null;
      u = URL.createObjectURL(row.blob);
      this.urls.set(clip.id, u);
    }
    return u;
  }

  private async load(clip: Clip, offset: number) {
    const url = await this.url(clip);
    if (!url) return false;
    this.idx = this.clips.indexOf(clip);
    if (this.audio.src !== url) {
      this.audio.src = url;
      await new Promise<void>((res) => {
        const ok = () => { this.audio.removeEventListener('loadedmetadata', ok); res(); };
        this.audio.addEventListener('loadedmetadata', ok);
        setTimeout(ok, 1500);
      });
    }
    try { this.audio.currentTime = Math.max(0, offset); } catch { /* not seekable yet */ }
    this.audio.playbackRate = this.rate;
    return true;
  }

  async seek(t: number) {
    this.t = Math.max(0, Math.min(t, this.duration));
    const clip = this.clipAt(this.t);
    if (clip) {
      if (this.t < clip.start) this.t = clip.start;
      await this.load(clip, this.t - clip.start);
      if (this.playing) await this.audio.play().catch(() => this.pause());
    }
    this.onTime(this.t);
  }

  async play() {
    if (this.t >= this.duration - 0.05) this.t = 0;
    this.playing = true;
    await this.seek(this.t);
    this.tick();
    this.onState();
  }

  pause() {
    this.playing = false;
    this.audio.pause();
    cancelAnimationFrame(this.raf);
    this.onState();
  }

  setRate(r: number) { this.rate = r; this.audio.playbackRate = r; }

  private tick = () => {
    if (!this.playing) return;
    const c = this.clips[this.idx];
    if (c && !this.audio.paused) {
      this.t = c.start + this.audio.currentTime;
      this.onTime(this.t);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private async next() {
    const c = this.clips[this.idx];
    const nextClip = c && this.clipAt(c.start + c.duration + 0.01);
    if (!nextClip || nextClip === c) {
      this.t = this.duration;
      this.onTime(this.t);
      this.pause();
      return;
    }
    this.t = nextClip.start;
    await this.seek(this.t);
  }

  destroy() {
    this.pause();
    this.audio.removeAttribute('src');
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}
