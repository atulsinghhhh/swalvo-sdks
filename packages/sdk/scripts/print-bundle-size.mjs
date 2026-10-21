import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(import.meta.dirname, '..', 'dist');
const files = ['index.js', 'index.cjs'];

console.log('@swalvo/rtc bundle size (own code only — no media-plane SDK is bundled; the browser supplies WebRTC):\n');

for (const file of files) {
  const path = join(distDir, file);
  const raw = readFileSync(path);
  const rawSize = statSync(path).size;
  const gzipSize = gzipSync(raw).length;
  console.log(
    `  dist/${file.padEnd(10)} raw: ${(rawSize / 1024).toFixed(2).padStart(7)} KB   gzip: ${(gzipSize / 1024).toFixed(2).padStart(7)} KB`,
  );
}
