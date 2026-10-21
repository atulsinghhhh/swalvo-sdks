// esbuild (tsup's bundler) drops a "use client" directive once multiple
// source files get concatenated into one output, because it can't prove the
// directive still applies after bundling, so it silently strips it
// instead of risk being wrong. Since every file in this package is
// genuinely client-only, the fix is just to prepend the directive to the
// built output files directly, after tsup is done. Run automatically as
// this package's `onSuccess` hook (see tsup.config.ts).
import { readFileSync, writeFileSync } from 'node:fs';

const DIRECTIVE = "'use client';\n";
// Every entry point in `tsup.config.ts` needs its own directive: Next.js
// reads it at the module the consumer imports, so the `./chat` subpath
// export is just as client-only as the barrel and cannot inherit it
// from `index`. Shared chunks need nothing; they're only ever reached
// through an entry that already carries the boundary.
const files = ['dist/index.js', 'dist/index.cjs', 'dist/chat.js', 'dist/chat.cjs'];

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  if (content.startsWith(DIRECTIVE)) continue;
  writeFileSync(file, DIRECTIVE + content);
  console.log(`[prepend-use-client] added "use client" to ${file}`);
}
