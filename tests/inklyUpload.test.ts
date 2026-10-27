import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../api/inkly';
import { serverBackend } from '../src/editor/inklyServer';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
afterEach(() => { vi.unstubAllGlobals(); delete env.GEMINI_API_KEY; });

describe('Inkly with a long note', () => {
  it('uploads pictures in small batches, then asks with file references, and reuses uploads', async () => {
    env.GEMINI_API_KEY = 'k';
    let fileN = 0;
    const uploadBodies: number[] = [];
    let asked: { contents: { parts: Record<string, unknown>[] }[] } | null = null;
    const google = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/upload/v1beta/files')) return new Response('{}', { headers: { 'x-goog-upload-url': 'https://up.example/session' } });
      if (url === 'https://up.example/session') return new Response(JSON.stringify({ file: { uri: `https://generativelanguage.googleapis.com/v1beta/files/f${++fileN}` } }));
      asked = JSON.parse(String(init!.body));
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    // The app talks to our function; our function talks to (mocked) Google.
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('./api/inkly')) {
        if (!init?.method) return new Response(JSON.stringify({ ok: true, provider: 'Gemini' }), { headers: { 'content-type': 'application/json' } });
        if (String(url).includes('upload')) uploadBodies.push(String(init.body).length);
        return POST(new Request(`http://x/api/inkly${String(url).includes('?upload') ? '?upload' : ''}`, { method: 'POST', body: init.body, headers: init.headers as HeadersInit }));
      }
      return google(String(url), init);
    });
    const ai = (await serverBackend())!;
    // 30 pages of ~150 KB: about 6 MB as base64, too much for one request.
    const pages = Array.from({ length: 30 }, () => new Blob([new Uint8Array(150_000).fill(7)], { type: 'image/jpeg' }));
    const r = await ai([{ role: 'user', content: 'What is on page 25?' }], { images: pages });
    expect(r.text).toBe('ok');
    expect(uploadBodies.length).toBeGreaterThan(1);
    expect(Math.max(...uploadBodies)).toBeLessThan(4_400_000);
    const parts = asked!.contents.at(-1)!.parts;
    expect(parts.filter((p) => 'file_data' in p)).toHaveLength(30);
    expect(parts.some((p) => 'inline_data' in p)).toBe(false);
    // A follow-up question about the same pages doesn't upload again.
    const before = uploadBodies.length;
    await ai([{ role: 'user', content: 'And page 3?' }], { images: pages });
    expect(uploadBodies.length).toBe(before);
    expect(asked!.contents.at(-1)!.parts.filter((p) => 'file_data' in p)).toHaveLength(30);
  });
});
