import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Options } from 'tsup';

// esbuild is tsup's own dependency, not this package's, so load the copy tsup uses.
const require = createRequire(import.meta.url);
const esbuild = require(
  require.resolve('esbuild', { paths: [dirname(require.resolve('tsup'))] }),
) as typeof import('esbuild');

/** Bundles the E2EE transform worker into one self-contained script. */
async function buildWorker(entry: string, minify: boolean): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify,
  });
  return result.outputFiles[0].text;
}

/**
 * `import source from './worker.ts?inline-worker'` → the worker, bundled,
 * as a string. Only `src/e2ee/manager.ts` does this, and only the key
 * providers import the manager, so an app that never enables E2EE
 * tree-shakes the whole worker away.
 */
const inlineWorker: NonNullable<Options['esbuildPlugins']>[number] = {
  name: 'inline-worker',
  setup(build) {
    build.onResolve({ filter: /\?inline-worker$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?inline-worker$/, '')),
      namespace: 'inline-worker',
    }));
    build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (args) => ({
      contents: `export default ${JSON.stringify(await buildWorker(args.path, true))};`,
      loader: 'js',
    }));
  },
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  platform: 'browser',
  treeshake: true,
  minify: false,
  metafile: true,
  esbuildPlugins: [inlineWorker],
  // Also ship the worker as a file (`@swalvo/rtc/e2ee-worker`) for apps
  // whose CSP forbids `blob:` workers.
  async onSuccess() {
    const out = resolve('dist/e2ee-worker.js');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, await buildWorker(resolve('src/e2ee/worker.ts'), true));
  },
});
