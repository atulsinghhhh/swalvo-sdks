import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, installCommand } from '../../src/lib/package-manager.js';

describe('detectPackageManager', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-pm-'));
  });

  afterEach(async () => {
    delete process.env.npm_config_user_agent;
    await rm(dir, { recursive: true, force: true });
  });

  it('detects pnpm from pnpm-lock.yaml', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    await expect(detectPackageManager(dir)).resolves.toBe('pnpm');
  });

  it('detects yarn from yarn.lock', async () => {
    await writeFile(join(dir, 'yarn.lock'), '');
    await expect(detectPackageManager(dir)).resolves.toBe('yarn');
  });

  it('detects bun from bun.lockb', async () => {
    await writeFile(join(dir, 'bun.lockb'), '');
    await expect(detectPackageManager(dir)).resolves.toBe('bun');
  });

  it('detects npm from package-lock.json', async () => {
    await writeFile(join(dir, 'package-lock.json'), '');
    await expect(detectPackageManager(dir)).resolves.toBe('npm');
  });

  it('falls back to npm_config_user_agent when no lockfile exists', async () => {
    process.env.npm_config_user_agent = 'pnpm/8.0.0 npm/? node/v20.0.0';
    await expect(detectPackageManager(dir)).resolves.toBe('pnpm');
  });

  it('defaults to npm when nothing else indicates otherwise', async () => {
    await expect(detectPackageManager(dir)).resolves.toBe('npm');
  });

  it('prefers a lockfile over npm_config_user_agent when both are present', async () => {
    await writeFile(join(dir, 'yarn.lock'), '');
    process.env.npm_config_user_agent = 'pnpm/8.0.0';
    await expect(detectPackageManager(dir)).resolves.toBe('yarn');
  });
});

describe('installCommand', () => {
  it('produces the correct install invocation per package manager', () => {
    expect(installCommand('pnpm', '@swalvo/rtc')).toBe('pnpm add @swalvo/rtc');
    expect(installCommand('yarn', '@swalvo/rtc')).toBe('yarn add @swalvo/rtc');
    expect(installCommand('bun', '@swalvo/rtc')).toBe('bun add @swalvo/rtc');
    expect(installCommand('npm', '@swalvo/rtc')).toBe('npm install @swalvo/rtc');
  });
});
