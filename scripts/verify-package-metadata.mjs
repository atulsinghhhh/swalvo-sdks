#!/usr/bin/env node
// Pre-publish gate for the packages under packages/.
//
// npm publish is effectively irreversible: unpublish is restricted to a
// 72-hour window and blocked outright once anything depends on you. So the
// checks that would otherwise be caught by a reviewer noticing a blank npm
// page run here instead, before the tarball is built.
//
// Run by .github/workflows/release.yml, and by hand:
//   node scripts/verify-package-metadata.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

const EXPECTED_REPO_URL = 'github.com/atulsinghhhh/swalvo-sdks';
const PREPUBLISH_GUARD = 'node ../../scripts/assert-publish-safe.mjs';

/** @type {{pkg: string, problem: string}[]} */
const problems = [];
/** @type {string[]} */
const checked = [];

const dirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const dir of dirs) {
  const pkgDir = join(packagesDir, dir);
  const manifestPath = join(pkgDir, 'package.json');
  if (!existsSync(manifestPath)) continue;

  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const name = pkg.name ?? dir;

  // A private package is not going to npm, so none of the rest applies.
  // Assert only that it really is marked private, since the failure mode
  // being guarded against is an internal app leaking onto the registry.
  if (pkg.private === true) {
    checked.push(`${name} (private — skipped)`);
    continue;
  }

  checked.push(name);
  const fail = (problem) => problems.push({ pkg: name, problem });

  // --- identity -----------------------------------------------------------
  if (!pkg.name) fail('no "name"');
  if (!pkg.version) fail('no "version"');
  if (!pkg.description) fail('no "description" — npm shows it under the package title');
  if (!pkg.license) fail('no "license"');
  else if (pkg.license !== 'MIT') fail(`license is "${pkg.license}", expected MIT to match the repo`);

  // --- scoped packages publish as private unless told otherwise -----------
  if (pkg.name?.startsWith('@')) {
    if (pkg.publishConfig?.access !== 'public') {
      fail('scoped package without publishConfig.access = "public" — npm publish will fail');
    }
  }

  // --- provenance links ---------------------------------------------------
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
  if (!repoUrl) fail('no "repository"');
  else if (!repoUrl.includes(EXPECTED_REPO_URL)) {
    fail(`"repository" does not point at ${EXPECTED_REPO_URL} (got: ${repoUrl})`);
  }
  if (!pkg.homepage) fail('no "homepage"');
  if (!pkg.bugs) fail('no "bugs"');

  // --- what actually ends up in the tarball -------------------------------
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail('no "files" array — the tarball would carry sources, tests and configs');
  }

  // npm bundles LICENSE and README automatically even when "files" omits
  // them, but only if they exist on disk. Without a README the npm page is
  // blank, which is the first thing anyone evaluating the SDK will see.
  if (!existsSync(join(pkgDir, 'README.md'))) fail('no README.md — the npm page would be blank');
  if (!existsSync(join(pkgDir, 'LICENSE'))) fail('no LICENSE file');

  // --- entry points -------------------------------------------------------
  const entries = [pkg.main, pkg.module, pkg.types].filter(Boolean);
  if (entries.length === 0 && !pkg.exports && !pkg.bin) {
    fail('no "main", "module", "types", "exports" or "bin" — nothing to import');
  }

  // --- unpublishable dependency ranges ------------------------------------
  // `workspace:*` is rewritten to a concrete version by pnpm at pack time —
  // and ONLY by pnpm. This check used to wave it through on that basis,
  // which is how @swalvo/rtc@0.1.0 and @swalvo/live@0.1.0 reached
  // the registry with a `"workspace:*"` sibling dependency intact, public
  // and completely uninstallable. A manifest range is not evidence of what
  // ends up in the tarball, so the real assertion now lives in
  // scripts/verify-pack-manifests.mjs, which packs and reads the result,
  // and in each package's `prepublishOnly` gate
  // (scripts/assert-publish-safe.mjs), which is the only one of the three
  // that survives someone running `npm publish` by hand.
  //
  // `file:`, `link:` and `portal:` are rewritten by nothing, so they stay a
  // hard failure right here.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (typeof range !== 'string') continue;
      if (range.startsWith('file:') || range.startsWith('link:') || range.startsWith('portal:')) {
        fail(`${field}["${dep}"] is "${range}" — cannot be published`);
      }
    }
  }

  // --- the gate that survives a hand-run publish --------------------------
  const usesWorkspaceProtocol = ['dependencies', 'peerDependencies', 'optionalDependencies'].some((field) =>
    Object.values(pkg[field] ?? {}).some((range) => typeof range === 'string' && range.startsWith('workspace:')),
  );
  if (usesWorkspaceProtocol && pkg.scripts?.prepublishOnly !== PREPUBLISH_GUARD) {
    fail(
      `uses the workspace protocol but scripts.prepublishOnly is not "${PREPUBLISH_GUARD}" — ` +
        'without it, `npm publish` from a laptop ships an uninstallable manifest',
    );
  }
}

// --- report -----------------------------------------------------------------
console.log(`Checked ${checked.length} package(s):`);
for (const name of checked) console.log(`  - ${name}`);
console.log('');

if (problems.length > 0) {
  console.error(`✗ ${problems.length} problem(s) found:\n`);
  for (const { pkg, problem } of problems) {
    console.error(`  ${pkg}: ${problem}`);
  }
  console.error('\nFix these before publishing. See docs/releases.md.');
  process.exit(1);
}

console.log('✓ All publishable packages carry complete metadata.');
