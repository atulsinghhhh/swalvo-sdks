import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCredentials, readCredentials, writeCredentials } from '../../src/lib/auth-store.js';
import { credentialsFilePath, swalvoHomeDir } from '../../src/lib/paths.js';

describe('auth-store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-auth-'));
    process.env.SWALVO_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.SWALVO_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when no credentials have been written', async () => {
    await expect(readCredentials()).resolves.toBeUndefined();
  });

  it('round-trips written credentials exactly', async () => {
    const stored = {
      token: 'jwt.value.here',
      email: 'dev@example.com',
      apiUrl: 'http://localhost:4100',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await writeCredentials(stored);
    await expect(readCredentials()).resolves.toEqual(stored);
  });

  it('writes the credentials file with owner-only permissions (chmod 600)', async () => {
    await writeCredentials({ token: 't', email: 'e@x.com', apiUrl: 'http://x', createdAt: '2026-01-01T00:00:00.000Z' });
    const info = await stat(credentialsFilePath());
    // Mask off the file-type bits, keep just the permission bits.
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('creates ~/.swalvo with owner-only directory permissions (chmod 700)', async () => {
    await writeCredentials({ token: 't', email: 'e@x.com', apiUrl: 'http://x', createdAt: '2026-01-01T00:00:00.000Z' });
    const info = await stat(swalvoHomeDir());
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('clearCredentials removes the file without throwing when it does not exist', async () => {
    await clearCredentials();
    await clearCredentials();
    await expect(readCredentials()).resolves.toBeUndefined();
  });

  it('clearCredentials actually removes previously-written credentials', async () => {
    await writeCredentials({ token: 't', email: 'e@x.com', apiUrl: 'http://x', createdAt: '2026-01-01T00:00:00.000Z' });
    await clearCredentials();
    await expect(readCredentials()).resolves.toBeUndefined();
  });
});
