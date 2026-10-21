#!/usr/bin/env node
// Packs every publishable package with the real packer and inspects the
// manifest *inside the tarball* — the only artifact that matters, and the
// one nobody was looking at when @swalvo/rtc@0.1.0 went out with
// `workspace:*` in its dependencies.
//
// The release workflow previously ran `npm publish --dry-run` here, which
// reports the file list but never validates dependency ranges. It passed on
// a tarball no external developer could install.
//
// Assumes packages are already built (`pnpm --filter "./packages/*" run
// build`), since "files" is just ["dist"] for most of them.
//
//   node scripts/verify-pack-manifests.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

/** Ranges that resolve inside a workspace and nowhere else. */
const UNPUBLISHABLE_PREFIXES = ['workspace:', 'file:', 'link:', 'portal:'];
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/** @type {{pkg: string, problem: string}[]} */
const problems = [];
/** @type {string[]} */
const checked = [];

const stagingDir = mkdtempSync(join(tmpdir(), 'raven-pack-'));

try {
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of dirs) {
    const pkgDir = join(packagesDir, dir);
    if (!existsSync(join(pkgDir, 'package.json'))) continue;

    const source = readManifest(join(pkgDir, 'package.json'));
    if (source.private === true) continue;

    const name = source.name ?? dir;
    checked.push(name);
    const fail = (problem) => problems.push({ pkg: name, problem });

    let tarball;
    try {
      // pnpm, deliberately: it is the packer the release path uses, and the
      // rewrite being verified is its behaviour, not npm's.
      const output = execFileSync('pnpm', ['pack', '--pack-destination', stagingDir], {
        cwd: pkgDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      tarball = output.trim().split('\n').pop().trim();
    } catch (error) {
      fail(`pnpm pack failed: ${error.stderr?.trim() || error.message}`);
      continue;
    }

    const contents = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean);

    const packed = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));

    // --- the range check this script exists for --------------------------
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(packed[field] ?? {})) {
        if (typeof range !== 'string') continue;
        const prefix = UNPUBLISHABLE_PREFIXES.find((p) => range.startsWith(p));
        if (prefix) {
          fail(
            `${field}["${dep}"] is "${range}" in the packed manifest — the ` +
              `"${prefix}" protocol resolves only inside this workspace, so ` +
              'installing from npm fails outright. Pack with pnpm, which ' +
              'rewrites it to a concrete version.',
          );
        }
      }
    }

    // A dependency on a sibling package is only installable if that sibling
    // is actually going to the registry under that name.
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(packed[field] ?? {})) {
        if (!dep.startsWith('@swalvo/')) continue;
        const siblingDir = dirs.find((d) => {
          const manifestPath = join(packagesDir, d, 'package.json');
          return existsSync(manifestPath) && readManifest(manifestPath).name === dep;
        });
        if (siblingDir && readManifest(join(packagesDir, siblingDir, 'package.json')).private === true) {
          fail(`${field}["${dep}"] points at a private package — it will never be on npm`);
        }
      }
    }

    // --- the tarball carries something importable ------------------------
    if (Array.isArray(source.files) && source.files.includes('dist')) {
      if (!contents.some((entry) => entry.startsWith('package/dist/'))) {
        fail('tarball has no package/dist/ — build before packing, or the package ships empty');
      }
    }
    if (!contents.includes('package/package.json')) {
      fail('tarball has no package.json');
    }
  }
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}

function readManifest(path) {
  return JSON.parse(execFileSync('cat', [path], { encoding: 'utf8' }));
}

console.log(`Packed and inspected ${checked.length} package(s):`);
for (const name of checked) console.log(`  - ${name}`);
console.log('');

if (problems.length > 0) {
  console.error(`✗ ${problems.length} problem(s) in packed tarballs:\n`);
  for (const { pkg, problem } of problems) console.error(`  ${pkg}: ${problem}`);
  console.error('\nNothing here is fixable after the fact — npm unpublish is restricted');
  console.error('to 72 hours. See docs/releases.md.');
  process.exit(1);
}

console.log('✓ Every packed manifest is installable from the registry.');
