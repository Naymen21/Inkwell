import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST, resetCooling } from '../api/inkly';
import { serverBackend } from '../src/editor/inklyServer';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

const sse = (chunks: string[]) => new Response(new ReadableStream({
  start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); },
}), { headers: { 'content-type': 'text/event-stream' } });

const chunk = (text: string, finishReason?: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] })}\r\n\r\n`;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('http://x/api/inkly', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }));

afterEach(() => {
  resetCooling();
  vi.unstubAllGlobals();
  delete env.GEMINI_API_KEY; delete env.INKLY_PASSCODE; delete env.INKLY_MODEL;
});

describe('api/inkly', () => {
  it('reports whether it is configured', async () => {
    expect(await GET().json()).toMatchObject({ ok: false });
    env.GEMINI_API_KEY = 'k';
    expect(await GET().json()).toMatchObject({ ok: true, passcode: false, provider: 'Gemini' });
  });

  it('refuses without a key or with a wrong passcode', async () => {
    expect((await post({ turns: [{ role: 'user', content: 'hi' }] })).status).toBe(503);
    env.GEMINI_API_KEY = 'k';
    env.INKLY_PASSCODE = 'secret';
    const r = await post({ turns: [{ role: 'user', content: 'hi' }] }, { 'x-inkly-passcode': 'nope' });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: 'passcode' });
  });

  it('merges turns, attaches images to the last user turn, keeps the key in a header', async () => {
    env.GEMINI_API_KEY = 'k';
    let sent: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { sent = { url, init }; return sse([chunk('ok')]); }));
    const r = await post({
      turns: [{ role: 'user', content: 'rules' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }],
      images: ['aGVsbG8=', 'not base64!'],
    });
    expect(r.status).toBe(200);
    expect(sent!.url).toContain('gemini-flash-lite-latest:streamGenerateContent?alt=sse'); // quick questions: light model first
    expect(sent!.url).not.toContain('key=');
    expect((sent!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    const body = JSON.parse(String(sent!.init.body));
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[2].parts).toEqual([{ text: 'q2' }, { inline_data: { mime_type: 'image/jpeg', data: 'aGVsbG8=' } }]);
  });

  it('falls back to another model when one is overloaded', async () => {
    env.GEMINI_API_KEY = 'k';
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1 ? new Response('busy', { status: 503 }) : sse([chunk('ok')]);
    }));
    const r = await post({ turns: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect(urls).toHaveLength(2);
    expect(r.headers.get('x-inkly-model')).not.toBe('gemini-flash-lite-latest');
  });

  it('reports busy when every model is overloaded', async () => {
    env.GEMINI_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));
    expect(await (await post({ turns: [{ role: 'user', content: 'hi' }] })).json()).toMatchObject({ code: 'busy' });
  });

  it('asks for minimal thinking, and retries plainly if a model rejects it', async () => {
    env.GEMINI_API_KEY = 'k';
    const bodies: { generationConfig: { thinkingConfig?: unknown } }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1 ? new Response('{"error":{"message":"thinking_level is not supported"}}', { status: 400 }) : sse([chunk('ok')]);
    }));
    const r = await post({ turns: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect(bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(bodies[1].generationConfig.thinkingConfig).toBeUndefined();
  });

  it('study guides prefer the stronger model; a busy model is skipped next time', async () => {
    env.GEMINI_API_KEY = 'k';
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return urls.length === 1 ? new Response('busy', { status: 503 }) : sse([chunk('ok')]); }));
    await post({ turns: [{ role: 'user', content: 'guide' }], speed: 'quality' });
    expect(urls[0]).toContain('/gemini-flash-latest:');
    urls.length = 0;
    await post({ turns: [{ role: 'user', content: 'guide again' }], speed: 'quality' });
    expect(urls[0]).not.toContain('/gemini-flash-latest:'); // cooled down for a minute
  });

  it('streamtest streams chunks without calling Gemini', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = GET(new Request('http://x/api/inkly?streamtest'));
    const text = await r.text();
    expect(text.match(/chunk \d/g)).toHaveLength(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps Gemini quota errors to rate_limited', async () => {
    env.GEMINI_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })));
    const r = await post({ turns: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: 'rate_limited' });
  });
});

describe('inkly client backend', () => {
  it('is absent when the deployment has no function', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })));
    expect(await serverBackend()).toBeNull();
  });

  it('streams Gemini SSE text, split across network chunks', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'pw', setItem: () => {} });
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ ok: true, provider: 'Gemini' });
      calls.push(init);
      const all = chunk('Hello ') + chunk('world', 'STOP');
      return sse([all.slice(0, 17), all.slice(17, 60), all.slice(60)]);
    }));
    const be = await serverBackend();
    expect(be?.provider).toBe('Gemini');
    const seen: string[] = [];
    const out = await be!([{ role: 'user', content: 'hi' }], { onText: ({ text }) => seen.push(text) });
    expect(out).toEqual({ text: 'Hello world', truncated: false });
    expect(seen.at(-1)).toBe('Hello world');
    expect((calls[0].headers as Record<string, string>)['x-inkly-passcode']).toBe('pw');
  });

  it('turns server errors into coded rejections', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '', setItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method ? Response.json({ code: 'passcode', message: 'x' }, { status: 401 }) : Response.json({ ok: true })));
    const be = await serverBackend();
    await expect(be!([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ code: 'passcode' });
  });
});
