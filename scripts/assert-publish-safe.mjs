#!/usr/bin/env node
// Runs as `prepublishOnly` inside every publishable package, so it fires on
// both `pnpm publish` and a hand-run `npm publish` — including one run from
// a laptop, outside CI, where none of the release workflow's gates apply.
//
// It exists because @swalvo/rtc@0.1.0 and @swalvo/live@0.1.0 shipped
// with a `"workspace:*"` sibling dependency still in their manifests. The
// packages were public and downloadable; they just could not be installed:
//
//   npm  → EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"
//   pnpm → ERR_PNPM_WORKSPACE_PKG_NOT_FOUND <sibling>@workspace:*
//
// pnpm rewrites `workspace:*` to a concrete version when it packs. npm does
// not — it publishes the manifest verbatim. So the protocol is safe in the
// repo and fatal in a tarball, and the only thing standing between the two
// is which packer runs.

import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const name = manifest.name ?? process.cwd();

const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

// pnpm rewrites `workspace:` and nothing else. `file:`, `link:` and
// `portal:` survive into the tarball whichever packer runs, so they are
// fatal unconditionally.
const NEVER_PUBLISHABLE = ['file:', 'link:', 'portal:'];

const ranges = DEP_FIELDS.flatMap((field) =>
  Object.entries(manifest[field] ?? {})
    .filter(([, range]) => typeof range === 'string')
    .map(([dep, range]) => ({ label: `${field}["${dep}"] = "${range}"`, range })),
);

const workspaceRanges = ranges.filter((r) => r.range.startsWith('workspace:'));
const brokenRanges = ranges.filter((r) => NEVER_PUBLISHABLE.some((p) => r.range.startsWith(p)));

// `pnpm/10.x.y npm/? node/v22...` — pnpm identifies itself first.
const userAgent = process.env.npm_config_user_agent ?? '';
const packedByPnpm = userAgent.startsWith('pnpm/');

if (brokenRanges.length > 0) {
  console.error(`\n✗ ${name}: refusing to publish.\n`);
  console.error('These ranges resolve only on the machine that packed them:\n');
  for (const { label } of brokenRanges) console.error(`    ${label}`);
  console.error('\nNo packer rewrites them. Replace them with published versions.\n');
  process.exit(1);
}

if (workspaceRanges.length > 0 && !packedByPnpm) {
  console.error(`\n✗ ${name}: refusing to publish.\n`);
  console.error('These ranges use the workspace protocol:\n');
  for (const { label } of workspaceRanges) console.error(`    ${label}`);
  console.error(
    `\nThe packer is ${userAgent || '(unidentified)'}, which does not rewrite them.\n` +
      'Publishing now would put an uninstallable manifest on the registry, and\n' +
      'npm unpublish is restricted to 72 hours.\n\n' +
      'Publish with pnpm instead:\n\n' +
      '    pnpm publish            # from this package\n' +
      '    pnpm publish -r         # every package whose version is not yet on npm\n',
  );
  process.exit(1);
}
