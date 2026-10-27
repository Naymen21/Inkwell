// IDs, device identity and content hashing. All of these must work outside a
// secure context too (iPad hitting a dev server over the LAN is plain http),
// so every crypto call has a fallback.

export function uid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* insecure context */ }
  }
  const b = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let cachedDevice: string | null = null;
export function deviceId(): string {
  if (cachedDevice) return cachedDevice;
  try {
    cachedDevice = localStorage.getItem('inkwell.device');
    if (!cachedDevice) {
      cachedDevice = uid();
      localStorage.setItem('inkwell.device', cachedDevice);
    }
  } catch {
    cachedDevice = uid();
  }
  return cachedDevice;
}

/** Content address for media: SHA-256 when available, else a 2x53-bit hash. */
export async function hashBytes(buf: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const d = await subtle.digest('SHA-256', buf);
      return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
    } catch { /* fall through */ }
  }
  const a = new Uint8Array(buf);
  let h1 = 0xdeadbeef ^ a.length, h2 = 0x41c6ce57 ^ a.length;
  for (let i = 0; i < a.length; i++) {
    h1 = Math.imul(h1 ^ a[i], 2654435761);
    h2 = Math.imul(h2 ^ a[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'f' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + a.length.toString(16);
}
