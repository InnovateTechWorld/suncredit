// Cache busting without a build step. A short hash of every script and stylesheet is appended to their URLs (?v=<hash>), and an
// import map rewrites every module import the same way, so a new deploy changes every URL and no browser or edge cache can reuse
// an old copy. Computed once at start-up: the files do not change while the server runs. Node/container build only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), base) : [path.relative(base, path.join(dir, d.name))]));

export function buildVersionedIndex(pub) {
  const files = [...walk(path.join(pub, 'js')).map((f) => '/js/' + f.split(path.sep).join('/')), ...walk(path.join(pub, 'css')).map((f) => '/css/' + f.split(path.sep).join('/'))].filter((f) => /\.(?:js|css)$/.test(f)).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f).update(fs.readFileSync(path.join(pub, f)));
  const v = h.digest('hex').slice(0, 10);
  const map = Object.fromEntries(files.filter((f) => f.endsWith('.js')).map((f) => [f, `${f}?v=${v}`]));
  let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  html = html.replace(/(href|src)="(\/(?:js|css)\/[^"?]+\.(?:js|css))"/g, (_m, attr, url) => `${attr}="${url}?v=${v}"`);
  const importMap = JSON.stringify({ imports: map });
  html = html.replace('<script type="module"', `<script type="importmap">${importMap}</script>\n<script type="module"`);
  // The page's CSP forbids inline scripts; this one exact script is allowed by its hash.
  return { html, version: v, cspHash: `'sha256-${crypto.createHash('sha256').update(importMap).digest('base64')}'` };
}
