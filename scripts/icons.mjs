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

// A handwritten "squiggle" stroke on the accent background.
const path = [];
for (let i = 0; i <= 200; i++) {
  const t = i / 200;
  path.push([0.2 + 0.6 * t, 0.56 - 0.13 * Math.sin(t * Math.PI * 2.4) * (1 - 0.3 * t) - 0.06 * t]);
}
function distToPath(x, y) {
  let m = Infinity;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1], [bx, by] = path[i];
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    let t = ((x - ax) * dx + (y - ay) * dy) / l; t = Math.max(0, Math.min(1, t));
    m = Math.min(m, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return m;
}

function png(size, file) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const bg = [47, 107, 216], top = [80, 140, 240];
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const g = v;
      let r = top[0] + (bg[0] - top[0]) * g, gg = top[1] + (bg[1] - top[1]) * g, b = top[2] + (bg[2] - top[2]) * g;
      const d = distToPath(u, v) - 0.045;
      const a = Math.max(0, Math.min(1, 0.5 - d * size));
      r = r + (255 - r) * a; gg = gg + (255 - gg) * a; b = b + (255 - b) * a;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = gg; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const out = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(file, out);
}

for (const s of [180, 192, 512]) png(s, `public/icon-${s}.png`);
const d = path.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * 100).toFixed(1)} ${(y * 100).toFixed(1)}`).join('');
writeFileSync('public/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#508cf0"/><stop offset="1" stop-color="#2f6bd8"/></linearGradient></defs><rect width="100" height="100" rx="22" fill="url(#g)"/><path d="${d}" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`);
console.log('icons written');
