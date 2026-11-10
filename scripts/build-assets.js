// Collects everything the browser loads into .build/assets for Workers Static Assets: the app, the three font families
// (copied from node_modules, so nothing loads from a third party) and the security headers.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.build', 'assets');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true });

const FONT_DIRS = {
  bricolage: 'node_modules/@fontsource-variable/bricolage-grotesque/files',
  figtree: 'node_modules/@fontsource-variable/figtree/files',
  plex: 'node_modules/@fontsource/ibm-plex-mono/files',
};
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
let n = 0;
for (const [, family, file] of css.matchAll(/\/fonts\/(\w+)\/([\w.-]+)/g)) {
  const src = path.join(root, FONT_DIRS[family], file);
  if (!fs.existsSync(src)) throw new Error(`Missing font file for ${family}: ${file}. Run npm install.`);
  fs.mkdirSync(path.join(out, 'fonts', family), { recursive: true });
  fs.copyFileSync(src, path.join(out, 'fonts', family, file)); n++;
}
fs.writeFileSync(path.join(out, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'
/fonts/*
  Cache-Control: public, max-age=604800, immutable
`);
console.log(`assets ready: ${fs.readdirSync(out).length} top-level entries, ${n} font files`);
