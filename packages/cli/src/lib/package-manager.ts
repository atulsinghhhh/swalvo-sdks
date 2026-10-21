import { access } from 'node:fs/promises';
import { join } from 'node:path';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

const LOCKFILE_BY_MANAGER: Array<{ file: string; manager: PackageManager }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'package-lock.json', manager: 'npm' },
];

/**
 * Works out the package manager from lockfiles in `cwd` first, then falls
 * back to the npm_config_user_agent env var, which `npm exec`, `pnpm dlx`
 * and friends set. Only defaults to npm when nothing else matches.
 */
export async function detectPackageManager(cwd: string = process.cwd()): Promise<PackageManager> {
  for (const { file, manager } of LOCKFILE_BY_MANAGER) {
    if (await fileExists(join(cwd, file))) return manager;
  }

  const userAgent = process.env.npm_config_user_agent;
  if (userAgent?.startsWith('pnpm')) return 'pnpm';
  if (userAgent?.startsWith('yarn')) return 'yarn';
  if (userAgent?.startsWith('bun')) return 'bun';

  return 'npm';
}

export function installCommand(manager: PackageManager, packageName: string): string {
  switch (manager) {
    case 'pnpm':
      return `pnpm add ${packageName}`;
    case 'yarn':
      return `yarn add ${packageName}`;
    case 'bun':
      return `bun add ${packageName}`;
    case 'npm':
      return `npm install ${packageName}`;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
