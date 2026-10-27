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

export function GET() {
  return json({ ok: !!env('GEMINI_API_KEY'), passcode: !!env('INKLY_PASSCODE'), provider: 'Gemini' });
}

export async function POST(req: Request) {
  const key = env('GEMINI_API_KEY');
  if (!key) return json({ code: 'not_configured', message: 'GEMINI_API_KEY is not set' }, 503);
  const pass = env('INKLY_PASSCODE');
  if (pass && req.headers.get('x-inkly-passcode') !== pass) return json({ code: 'passcode', message: 'Wrong or missing passcode' }, 401);
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ code: 'prompt_too_large', message: 'Request too large' }, 413);

  let body: { turns?: Turn[]; images?: string[] };
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
  const models = configured ? [configured] : ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
  const body2 = JSON.stringify({ contents, generationConfig: { temperature: 0.4, maxOutputTokens: 8192 } });
  let last: { status: number; detail: string } = { status: 502, detail: 'Could not reach Gemini' };
  for (const model of models) {
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: body2,
      signal: req.signal,
    }).catch(() => null);
    if (upstream?.ok && upstream.body) {
      return new Response(upstream.body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-inkly-model': model } });
    }
    if (!upstream) continue;
    last = { status: upstream.status, detail: await upstream.text().catch(() => '') };
    if (![404, 429, 500, 503].includes(upstream.status)) break; // a real error: don't mask it
  }
  const s = last.status;
  const code = s === 429 ? 'rate_limited' : s === 503 ? 'busy' : s === 400 ? 'invalid_request' : s === 401 || s === 403 ? 'not_configured' : 'upstream_error';
  // Google's 429 says how long to wait (RetryInfo) and whether a per-day quota ran out.
  const retry = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(last.detail);
  const daily = s === 429 && /PerDay/i.test(last.detail);
  return json({ code, message: last.detail.slice(0, 300), retryAfter: retry ? Math.ceil(Number(retry[1])) : undefined, daily }, s === 429 ? 429 : 502);
}
