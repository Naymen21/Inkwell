// Vercel Function: Inkly's AI backend for the standalone (non-Claude) app.
// Holds the Gemini API key server-side and streams Gemini's answer back as
// server-sent events. Env:
//   GEMINI_API_KEY   required — free key from https://aistudio.google.com/apikey
//   INKLY_PASSCODE   optional — if set, requests must send it (x-inkly-passcode)
//   INKLY_MODEL      optional — defaults to the latest Gemini Flash

const MAX_BODY = 4_000_000; // Vercel request bodies cap at ~4.5 MB
const MAX_IMAGES = 8;
const MAX_TEXT = 200_000;

type Turn = { role: 'user' | 'assistant'; content: string };
type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const env = (k: string) => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[k];

export function GET(req?: Request) {
  // Diagnostic: ?streamtest sends 5 small chunks 400 ms apart, to check that
  // responses really stream to the browser (no Gemini call, no quota used).
  if (req && new URL(req.url).searchParams.has('streamtest')) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        for (let i = 1; i <= 5; i++) { c.enqueue(enc.encode(`data: chunk ${i} at ${Date.now()}\n\n`)); await new Promise((r) => setTimeout(r, 400)); }
        c.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }
  return json({ ok: !!env('GEMINI_API_KEY'), passcode: !!env('INKLY_PASSCODE'), provider: 'Gemini' });
}

// Models that just answered "busy"/"out of quota" are skipped for a minute
// (kept while this function instance stays warm), so a question doesn't wait
// on a known-busy model before reaching one that works.
const cooling = new Map<string, number>();
/** Tests only. */
export const resetCooling = () => cooling.clear();
const FAST = ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'];
const QUALITY = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];

export async function POST(req: Request) {
  const start = Date.now();
  const key = env('GEMINI_API_KEY');
  if (!key) return json({ code: 'not_configured', message: 'GEMINI_API_KEY is not set' }, 503);
  const pass = env('INKLY_PASSCODE');
  if (pass && req.headers.get('x-inkly-passcode') !== pass) return json({ code: 'passcode', message: 'Wrong or missing passcode' }, 401);
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ code: 'prompt_too_large', message: 'Request too large' }, 413);

  const t0 = Date.now();
  let body: { turns?: Turn[]; images?: string[]; speed?: 'fast' | 'quality'; timing?: unknown };
  try { body = await req.json(); } catch { return json({ code: 'invalid_request', message: 'Body must be JSON' }, 400); }
  const turns = Array.isArray(body.turns) ? body.turns.slice(-40) : [];
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!turns.length || turns[turns.length - 1].role !== 'user') return json({ code: 'invalid_request', message: 'Last turn must be from the user' }, 400);
  if (turns.reduce((n, t) => n + String(t.content ?? '').length, 0) > MAX_TEXT) return json({ code: 'prompt_too_large', message: 'Too much text' }, 413);

  // Gemini wants alternating user/model turns: merge consecutive same-role turns.
  const contents: { role: 'user' | 'model'; parts: Part[] }[] = [];
  for (const t of turns) {
    const role = t.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text: String(t.content) });
    else contents.push({ role, parts: [{ text: String(t.content) }] });
  }
  const lastUser = contents[contents.length - 1];
  for (const data of images) {
    if (typeof data === 'string' && /^[A-Za-z0-9+/=]+$/.test(data)) lastUser.parts.push({ inline_data: { mime_type: 'image/jpeg', data } });
  }

  // Free-tier models get overloaded at times; fall through to the next one
  // when a model is busy (503), out of quota (429) or not offered (404).
  const configured = env('INKLY_MODEL');
  // Quick questions go to the light model first (answers in about a second);
  // study guides and flashcards prefer the stronger model.
  const order = configured ? [configured] : body.speed === 'quality' ? QUALITY : FAST;
  const now = Date.now();
  const ready = order.filter((m) => (cooling.get(m) ?? 0) < now);
  const models = ready.length ? ready : order;
  const attempts: { model: string; status: number; ms: number }[] = [];
  const bytes = Number(req.headers.get('content-length') ?? 0);
  const log = (extra: object) => console.log(JSON.stringify({ inkly: { speed: body.speed ?? 'fast', images: images.length, kb: Math.round(bytes / 1024), upMs: t0 - start, device: body.timing, attempts, ...extra } }));
  const base = { temperature: 0.4, maxOutputTokens: 8192 };
  const call = (model: string, generationConfig: object) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents, generationConfig }),
      signal: req.signal,
    }).catch(() => null);
  let last: { status: number; detail: string } = { status: 502, detail: 'Could not reach Gemini' };
  for (const model of models) {
    // Speed: thinking delays the first word by seconds. Keep it minimal
    // (2.5 models take a token budget, newer ones a level).
    const thinking = /2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' };
    const ta = Date.now();
    let upstream = await call(model, { ...base, thinkingConfig: thinking });
    if (upstream && upstream.status === 400) {
      // This model doesn't accept that thinking setting: ask again with the default.
      const detail = await upstream.clone().text().catch(() => '');
      if (/thinking/i.test(detail)) { attempts.push({ model: `${model}+thinking`, status: 400, ms: Date.now() - ta }); upstream = await call(model, base); }
    }
    attempts.push({ model, status: upstream?.status ?? 0, ms: Date.now() - ta });
    if (upstream?.ok && upstream.body) {
      log({ model, firstByteMs: Date.now() - t0 });
      return new Response(upstream.body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-inkly-model': model } });
    }
    if (!upstream) continue;
    last = { status: upstream.status, detail: await upstream.text().catch(() => '') };
    if ([429, 503].includes(upstream.status)) cooling.set(model, Date.now() + 60_000);
    if (upstream.status === 404) cooling.set(model, Date.now() + 3_600_000);
    if (![404, 429, 500, 503].includes(upstream.status)) break; // a real error: don't mask it
  }
  log({ failed: last.status });
  const s = last.status;
  const code = s === 429 ? 'rate_limited' : s === 503 ? 'busy' : s === 400 ? 'invalid_request' : s === 401 || s === 403 ? 'not_configured' : 'upstream_error';
  // Google's 429 says how long to wait (RetryInfo) and whether a per-day quota ran out.
  const retry = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(last.detail);
  const daily = s === 429 && /PerDay/i.test(last.detail);
  return json({ code, message: last.detail.slice(0, 300), retryAfter: retry ? Math.ceil(Number(retry[1])) : undefined, daily }, s === 429 ? 429 : 502);
}
