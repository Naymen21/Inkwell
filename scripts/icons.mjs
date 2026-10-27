// Generates PWA / apple-touch PNG icons without any image dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

// Inkwell mark: white fountain-pen nib (slit + breather hole) on a blue-indigo gradient.
const S = (x, y) => [x / 24, y / 24];
const cubic = (p0, p1, p2, p3, n) => Array.from({ length: n }, (_, i) => {
  const t = (i + 1) / n, u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
});
// Same outline as the SVG path, in absolute coordinates.
const nib = [[12, 3.6],
  ...cubic([12, 3.6], [14.9, 6.1], [16.9, 9], [16.9, 11.9], 16),
  ...cubic([16.9, 11.9], [16.9, 13.7], [16, 15.1], [14.6, 15.9], 8),
  [12, 20.4], [9.4, 15.9],
  ...cubic([9.4, 15.9], [8, 15.1], [7.1, 13.7], [7.1, 11.9], 8),
  ...cubic([7.1, 11.9], [7.1, 9], [9.1, 6.1], [12, 3.6], 16)].map(([x, y]) => S(x, y));
const slit = [S(12, 12.6), S(12, 18.8)];
const hole = { c: S(12, 11.4), r: 1.45 / 24 };
const segDist = (x, y, pts, closed) => {
  let m = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy || 1;
    let t = ((x - ax) * dx + (y - ay) * dy) / l; t = Math.max(0, Math.min(1, t));
    m = Math.min(m, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return m;
};
const inside = (x, y, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

function png(size, file) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const top = [111, 145, 255], mid = [74, 92, 232], bot = [61, 68, 207], white = [255, 255, 255], ink = [61, 74, 214];
  const k = 0.86; // artwork scale inside the tile (iOS rounds the corners itself)
  const px = 1 / (size * k);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const g = (y / size) * 0.8 + (x / size) * 0.2;
      const from = g < 0.55 ? top : mid, to = g < 0.55 ? mid : bot, t = g < 0.55 ? g / 0.55 : (g - 0.55) / 0.45;
      let c = from.map((ch, i) => ch + (to[i] - ch) * t);
      const u = ((x + 0.5) / size - 0.5) / k + 0.5, v = ((y + 0.5) / size - 0.5) / k + 0.5;
      const dn = segDist(u, v, nib, true) * (inside(u, v, nib) ? -1 : 1);
      const an = Math.max(0, Math.min(1, 0.5 - dn / px));
      c = c.map((ch, i) => ch + (white[i] - ch) * an);
      const ds = segDist(u, v, slit, false) - 0.65 / 24;
      const dh = Math.hypot(u - hole.c[0], v - hole.c[1]) - hole.r;
      const ai = Math.max(0, Math.min(1, 0.5 - Math.min(ds, dh) / px)) * an;
      c = c.map((ch, i) => ch + (ink[i] - ch) * ai);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const out = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(file, out);
}

for (const s of [180, 192, 512]) png(s, `public/icon-${s}.png`);
console.log('icons written');
