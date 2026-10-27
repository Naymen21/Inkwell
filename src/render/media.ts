// Decoded image cache keyed by content hash. Loads lazily from IndexedDB and
// notifies listeners so pages using the image can repaint once it arrives.
import { db } from '../persist/db';

type Drawable = ImageBitmap | HTMLImageElement;

class MediaCache {
  private images = new Map<string, Drawable>();
  private loading = new Set<string>();
  private listeners = new Set<(hash: string) => void>();

  onLoad(fn: (hash: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  image(hash: string): Drawable | null {
    const img = this.images.get(hash);
    if (img) return img;
    if (!this.loading.has(hash)) this.load(hash);
    return null;
  }

  async ready(hash: string): Promise<Drawable | null> {
    if (this.images.has(hash)) return this.images.get(hash)!;
    await this.load(hash);
    return this.images.get(hash) ?? null;
  }

  private async load(hash: string) {
    this.loading.add(hash);
    try {
      const blob = await db.getMedia(hash);
      if (!blob) return;
      this.images.set(hash, await decode(blob));
      for (const l of this.listeners) l(hash);
    } catch (e) {
      console.warn('media load failed', hash, e);
    } finally {
      this.loading.delete(hash);
    }
  }

  put(hash: string, img: Drawable) { this.images.set(hash, img); }
}

export async function decode(blob: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* fall back (e.g. SVG) */ }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

export const media = new MediaCache();
