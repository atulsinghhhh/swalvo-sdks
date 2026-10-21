import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/raven.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  clean: true,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
