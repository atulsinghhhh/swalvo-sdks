import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * The monorepo's lint baseline.
 *
 * One config for apps/api and every package under packages/. The dashboard
 * is excluded on purpose: Next.js needs eslint-config-next's own rules
 * (server components, image usage, core web vitals), so it keeps
 * apps/dashboard/eslint.config.mjs and its own `lint` script. Same for
 * apps/www and apps/docs too. Every Next.js app in the monorepo keeps its
 * own Next-flavoured config instead of sharing this one.
 *
 * Rules here are the non-type-aware set. Type-aware linting catches more,
 * floating promises above all, but it needs a project graph across eight
 * packages and is markedly slower. Worth doing as its own change, with the
 * errors it surfaces triaged properly, rather than smuggled into the change
 * that makes lint exist at all.
 */
export default tseslint.config(
  {
    // Nothing below this line is ours to lint. `generated` is Prisma's
    // client: hundreds of thousands of machine-written lines that would
    // dominate any report.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      // Dart/Flutter tool output — compiled JS from `flutter build web`
      // and pub's cache. Generated, gitignored, never hand-edited.
      '**/.dart_tool/**',
      '**/.verify-dist/**',
      'apps/api/src/generated/**',
      // Vendored SDK builds, copied from packages/*/dist so the browser
      // e2e harness can load them without a bundler. Same reason `dist`
      // is ignored: nobody edits these, and linting a minified-ish build
      // output produces only noise.
      'apps/api/test/e2e-harness/vendor/**',
      // Same again for the capacity rig: staged copies of the published
      // SDK builds, plus raw measurement output and generated Y4M.
      'scripts/capacity/harness/vendor/**',
      'scripts/capacity/results/**',
      'scripts/capacity/.content/**',
      // Same again for the egress worker's own harness: a staged copy of
      // the published SDK builds, rebuilt from source via stage-harness-sdk.mjs.
      'services/egress-worker/src/harness/vendor/**',
      'apps/dashboard/**',
      'apps/www/**',
      'apps/docs/**',
      'sdks/**',
      'examples/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Browser-side harnesses: plain ES modules loaded by a real page, so
    // `window`/`document`/`location` are exactly what they look like.
    // Declared separately because the default for a bare `.js` file in
    // this repo is a Node script — which `test/server.mjs`, sitting one
    // directory up from `test/public`, genuinely is.
    // docs/repro/* are diagnostic snippets meant to be pasted into a
    // DevTools console against a live page, so they are browser code that
    // happens to live under docs/.
    files: [
      'apps/api/test/e2e-harness/*.js',
      'scripts/capacity/harness/*.js',
      'services/egress-worker/src/harness/*.js',
      'test/public/*.js',
      'docs/repro/*.js',
    ],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  {
    // The chat-audit harness drives real Chrome through Playwright. These
    // are Node scripts, but the callbacks handed to page.evaluate and
    // waitForFunction are serialized and run inside the page, so `window`
    // in them is the browser's. ESLint cannot scope globals any finer than
    // a file, hence both sets here rather than a narrower glob.
    files: ['scripts/chat-audit/harness/*.mjs', 'scripts/capacity/*.mjs', 'scripts/capacity/lib/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // An unused parameter is often quite deliberate: an interface being
      // satisfied, a positional argument being skipped. Leading underscore
      // is the established way to say "intentionally unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // `any` is a real signal in a codebase whose whole selling point is
      // typed SDKs, but it is not always avoidable at an FFI boundary
      // (raw WebRTC stats dictionaries, WebSocket frames). Warn so it stays visible
      // without blocking a build.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Catching an error and doing nothing is sometimes right here: a
      // best-effort telemetry post, a cleanup that must not throw. Those are
      // written as `.catch(() => undefined)`, which this rule allows; a bare
      // empty block is what it flags.
      'no-empty': ['error', { allowEmptyCatch: false }],

      'no-console': 'off',
    },
  },

  {
    // Tests reach for globals and loose typing that production code should
    // not. Jest's globals are injected, not imported.
    files: ['**/*.spec.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.e2e-spec.ts', '**/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.jest, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  {
    // @swalvo/react ships hooks, so the rules of hooks aren't advisory
    // here: a dependency array that lies is a stale-closure bug in someone
    // else's application. The package already carries exhaustive-deps disable
    // comments; without the plugin loaded those comments were themselves
    // errors ("definition for rule not found").
    files: ['packages/react-sdk/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  {
    // `require()` inside a test is how jest module mocking works, and how a
    // test reaches for a module it has just re-registered. Production code
    // has no such excuse and is still held to imports.
    files: ['**/*.spec.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.e2e-spec.ts', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    // Load scripts run inside k6's own JS runtime, not Node. k6 injects a
    // handful of magic globals that no `globals` preset covers: `__ENV`
    // (the environment map passed via `-e`), and `__VU`/`__ITER` (the
    // virtual-user and iteration counters used to key per-VU test data).
    // They are read-only from the script's point of view.
    files: ['scripts/k6/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
  },
);
