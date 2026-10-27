// Turns the Vite build into a claude.ai Artifact: a body-fragment page that
// references the built assets by relative path (the platform adds the
// <!doctype>/<head> skeleton). Run after `vite build`; output: dist/artifact.html.
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const assets = join(dist, 'assets');

// Serve every script as .js: artifact hosting maps types by extension.
for (const f of readdirSync(assets)) {
  if (!f.endsWith('.mjs')) continue;
  const js = f.replace(/\.mjs$/, '.js');
  renameSync(join(assets, f), join(assets, js));
  for (const g of readdirSync(assets)) {
    if (!/\.(js|mjs)$/.test(g)) continue;
    const p = join(assets, g);
    const src = readFileSync(p, 'utf8');
    if (src.includes(f)) writeFileSync(p, src.split(f).join(js));
  }
}

// Artifact hosting rejects raw control characters. In the bundled libraries
// they only occur inside string/template/regex literals, where a \xNN escape
// denotes the same character.
for (const g of readdirSync(assets)) {
  if (!g.endsWith('.js')) continue;
  const p = join(assets, g);
  const src = readFileSync(p, 'utf8');
  // eslint-disable-next-line no-control-regex
  const out = src.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  if (out !== src) writeFileSync(p, out);
}

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const pick = (re) => [...html.matchAll(re)].map((m) => m[0]);
const styles = pick(/<link rel="stylesheet"[^>]*>/g);
const scripts = pick(/<script type="module"[^>]*><\/script>/g);
const preloads = pick(/<link rel="modulepreload"[^>]*>/g);

const page = [
  '<title>Inkwell</title>',
  ...styles,
  ...preloads,
  '<div id="app"></div>',
  ...scripts,
  '',
].join('\n');
writeFileSync(join(dist, 'artifact.html'), page);
console.log(page);
console.log('assets:', readdirSync(assets).join(', '));
