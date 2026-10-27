// Inkly over the app's own /api/inkly function (Gemini), for copies of
// Inkwell that run outside Claude. Exposes the same call shape as the
// claude.ai `sample` capability so the panel doesn't care which one it has.

type Role = 'user' | 'assistant';
type Opts = { signal?: AbortSignal; images?: Blob[]; onText?: (u: { text: string; delta: string }) => void; cache?: boolean; speed?: 'fast' | 'quality'; timing?: unknown };

export interface InklyBackend {
  (input: { role: Role; content: string }[], opts?: Opts): Promise<{ text: string; truncated: boolean }>;
  limits(): Promise<{ maxPromptBytes: number; images?: { maxCount: number } }>;
  provider?: string;
}

const PASS_KEY = 'inkwell.inklyPasscode';
export const getPasscode = () => { try { return localStorage.getItem(PASS_KEY) ?? ''; } catch { return ''; } };
export const setPasscode = (v: string) => { try { localStorage.setItem(PASS_KEY, v); } catch { /* blocked */ } };

const toBase64 = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

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
    const images = await Promise.all((opts.images ?? []).slice(0, 8).map(toBase64));
    let text = '';
    let res: Response;
    try {
      res = await fetch('./api/inkly', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-inkly-passcode': getPasscode() },
        body: JSON.stringify({ turns: input, images, speed: opts.speed ?? 'fast', timing: opts.timing }),
        signal: opts.signal,
      });
    } catch {
      throw opts.signal?.aborted ? { code: 'cancelled' } : { code: 'upstream_error', message: 'Network error' };
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
  fn.limits = async () => ({ maxPromptBytes: 200_000, images: { maxCount: 8 } });
  fn.provider = info.provider ?? 'Gemini';
  return fn;
}
