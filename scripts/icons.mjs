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

// Inkwell mark: white hooked stem with a yellow ink drop, on brand indigo (24-unit artboard).
const S = (x, y) => [x / 24, y / 24];
const stem = [S(10.6, 12)];
for (let i = 0; i <= 12; i++) stem.push(S(10.6, 12 + (4.6 * i) / 12));
for (let i = 1; i <= 16; i++) { const t = Math.PI - (Math.PI / 2) * (i / 16); stem.push(S(13.2 + 2.6 * Math.cos(t), 16.6 + 2.6 * Math.sin(t))); }
stem.push(S(14.1, 19.2));
const drop = [S(10.6, 3.6)];
const tan = Math.asin(2.6 / (8.2 - 3.6));
for (let i = 0; i <= 40; i++) { const a = -Math.PI / 2 + tan + ((2 * Math.PI - 2 * tan) * i) / 40; drop.push(S(10.6 + 2.6 * Math.cos(a), 8.2 + 2.6 * Math.sin(a))); }
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
  const bg = [59, 54, 196], white = [255, 255, 255], yellow = [255, 200, 61];
  // Artwork occupies the middle of the tile (iOS rounds the corners itself).
  const k = 0.92;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size - 0.5) / k + 0.49, v = ((y + 0.5) / size - 0.5) / k + 0.475;
      let c = bg.slice();
      const px = 1 / (size / k);
      const ds = segDist(u, v, stem, false) - 1.5 / 24;
      const a1 = Math.max(0, Math.min(1, 0.5 - ds / px));
      c = c.map((ch, i) => ch + (white[i] - ch) * a1);
      const dd = segDist(u, v, drop, true) * (inside(u, v, drop) ? -1 : 1);
      const a2 = Math.max(0, Math.min(1, 0.5 - dd / px));
      c = c.map((ch, i) => ch + (yellow[i] - ch) * a2);
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
writeFileSync('public/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="#3b36c4"/><g transform="translate(-0.4 -0.6)"><path d="M10.6 12v4.6a2.6 2.6 0 002.6 2.6h.9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M10.6 3.6c1.6 2 2.6 3.4 2.6 4.6a2.6 2.6 0 01-5.2 0c0-1.2 1-2.6 2.6-4.6z" fill="#ffc83d"/></g></svg>
`);
console.log('icons written');
