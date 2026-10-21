import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/chat.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  platform: 'browser',
  treeshake: true,
  minify: false,
  external: ['react', 'react-dom', '@swalvo/rtc', '@swalvo/chat'],
  // esbuild strips a source-level "use client" directive once several files
  // get bundled together, because it can't prove the directive still applies
  // to the concatenated output. A `banner` runs into the same problem when
  // combined with a source-level directive: two directives, both dropped.
  // The real fix is scripts/prepend-use-client.mjs, which runs as this
  // package's postbuild step. scripts/copy-styles.mjs then ships the chat
  // and video UI kits' optional stylesheets, which no bundler step imports.
  onSuccess: 'node scripts/prepend-use-client.mjs && node scripts/copy-styles.mjs',
});
