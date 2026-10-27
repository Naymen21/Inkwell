// Inkly over the app's own /api/inkly function (Gemini), for copies of
// Inkwell that run outside Claude. Exposes the same call shape as the
// claude.ai `sample` capability so the panel doesn't care which one it has.

type Role = 'user' | 'assistant';
/** Page pictures per question (the function accepts the same). */
const MAX_IMAGES = 100;
type Opts = { signal?: AbortSignal; images?: Blob[]; onText?: (u: { text: string; delta: string }) => void; cache?: boolean; speed?: 'fast' | 'quality'; timing?: unknown };

export interface InklyBackend {
  (input: { role: Role; content: string }[], opts?: Opts): Promise<{ text: string; truncated: boolean }>;
  limits(): Promise<{ maxPromptBytes: number; images?: { maxCount: number } }>;
  provider?: string;
}

const PASS_KEY = 'inkwell.inklyPasscode';
export const getPasscode = () => { try { return localStorage.getItem(PASS_KEY) ?? ''; } catch { return ''; } };
export const setPasscode = (v: string) => { try { localStorage.setItem(PASS_KEY, v); } catch { /* blocked */ } };

const toBase64 = async (b: Blob) => {
  const u = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** One request must stay under Vercel's ~4.5 MB body limit. */
const BATCH = 3_400_000;
/** Pictures already stored with Gemini (kept 48 h; reused for 40 h). */
const uploaded = new WeakMap<Blob, { uri: string; until: number }>();

/**
 * Store pictures with Gemini through ?upload, a few at a time, and return
 * their URIs in order. Pictures uploaded for an earlier question are reused.
 */
async function uploadAll(blobs: Blob[], b64: string[], signal?: AbortSignal): Promise<string[]> {
  const now = Date.now();
  const uris: string[] = blobs.map((b) => { const u = uploaded.get(b); return u && u.until > now ? u.uri : ''; });
  const todo = blobs.map((_, i) => i).filter((i) => !uris[i]);
  const batches: number[][] = [];
  let cur: number[] = [], size = 0;
  for (const i of todo) {
    if (cur.length && size + b64[i].length > BATCH) { batches.push(cur); cur = []; size = 0; }
    cur.push(i);
    size += b64[i].length;
  }
  if (cur.length) batches.push(cur);
  // A few batches in parallel: faster than one by one, gentle on the function.
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const r = await fetch('./api/inkly?upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-inkly-passcode': getPasscode() },
        body: JSON.stringify({ images: batch.map((i) => b64[i]) }),
        signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(j.uris)) throw { code: j.code ?? 'upstream_error', message: j.message ?? 'Upload failed' };
      batch.forEach((i, k) => { uris[i] = j.uris[k]; uploaded.set(blobs[i], { uri: j.uris[k], until: Date.now() + 40 * 3600_000 }); });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return uris;
}

/** Probe the function; null when this deployment has no AI backend. */
export async function serverBackend(): Promise<InklyBackend | null> {
  let info: { ok?: boolean; provider?: string };
  try {
    const r = await fetch('./api/inkly', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    info = await r.json();
  } catch { return null; }
  if (!info.ok) return null;

  const fn = (async (input, opts = {}) => {
    const blobs = (opts.images ?? []).slice(0, MAX_IMAGES);
    let images = await Promise.all(blobs.map(toBase64));
    let files: string[] = [];
    let text = '';
    let res: Response;
    try {
      // Too big for one request (long note): upload the pictures first, then ask.
      const total = images.reduce((n, s) => n + s.length, 0) + JSON.stringify(input).length;
      if (total > BATCH) { files = await uploadAll(blobs, images, opts.signal); images = []; }
      res = await fetch('./api/inkly', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-inkly-passcode': getPasscode() },
        body: JSON.stringify({ turns: input, images, files, speed: opts.speed ?? 'fast', timing: opts.timing }),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw { code: 'cancelled' };
      throw (e as { code?: string }).code ? e : { code: 'upstream_error', message: 'Network error' };
    }
    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({}));
      throw { code: e.code ?? 'upstream_error', message: e.message ?? res.statusText, retryAfter: e.retryAfter, daily: e.daily };
    }
    // Gemini SSE: each `data:` line is a JSON chunk with candidate text parts.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let truncated = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let chunk: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
          try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
          if (chunk.promptFeedback?.blockReason) throw { code: 'refused', message: chunk.promptFeedback.blockReason };
          const c = chunk.candidates?.[0];
          if (c?.finishReason === 'MAX_TOKENS') truncated = true;
          if (c?.finishReason === 'SAFETY') throw { code: 'refused', text };
          const delta = (c?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
          if (delta) { text += delta; opts.onText?.({ text, delta }); }
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) throw { code: 'cancelled', text };
      throw (e as { code?: string }).code ? { ...(e as object), text } : { code: 'upstream_error', text };
    }
    if (!text.trim()) throw { code: 'empty_completion' };
    return { text, truncated };
  }) as InklyBackend;
  fn.limits = async () => ({ maxPromptBytes: 200_000, images: { maxCount: MAX_IMAGES } });
  fn.provider = info.provider ?? 'Gemini';
  return fn;
}
