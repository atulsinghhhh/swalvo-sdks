import { jest } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCliConfig, updateCliConfig } from '../../src/lib/cli-config.js';
import { clearCredentials, credentialsFromEnv, readCredentials } from '../../src/lib/auth-store.js';
import { readProjectConfig } from '../../src/lib/project-config.js';
import { swalvoHomeDir } from '../../src/lib/paths.js';
import { resetLegacyEnvWarning } from '../../src/lib/env.js';

/**
 * The CLI was `raven` before the Swalvo rename. Everything a pre-rename
 * install relied on (env vars, ~/.raven, raven.json) must keep working.
 */
describe('pre-rename (raven) compatibility', () => {
  let home: string;
  let stderr: string[];
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let homeSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'swalvo-cli-legacy-'));
    homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(home);
    for (const name of [
      'SWALVO_CONFIG_DIR',
      'RAVEN_CONFIG_DIR',
      'SWALVO_TOKEN',
      'RAVEN_TOKEN',
      'SWALVO_API_URL',
      'RAVEN_API_URL',
      'LIVQENO_API_URL',
    ]) {
      delete process.env[name];
    }
    resetLegacyEnvWarning();
    stderr = [];
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    homeSpy.mockRestore();
    for (const name of ['RAVEN_CONFIG_DIR', 'RAVEN_TOKEN', 'RAVEN_API_URL', 'LIVQENO_API_URL', 'SWALVO_API_URL']) {
      delete process.env[name];
    }
    await rm(home, { recursive: true, force: true });
  });

  it('defaults to ~/.swalvo', () => {
    expect(swalvoHomeDir()).toBe(join(home, '.swalvo'));
  });

  it('reads ~/.raven files when ~/.swalvo has none, and writes to ~/.swalvo without touching ~/.raven', async () => {
    await mkdir(join(home, '.raven'));
    await writeFile(
      join(home, '.raven', 'config.json'),
      JSON.stringify({ apiUrl: 'https://old.example', currentProject: 'p1' }),
    );
    await writeFile(
      join(home, '.raven', 'credentials.json'),
      JSON.stringify({ token: 't', email: 'a@example.com', apiUrl: 'https://old.example', createdAt: 'x' }),
    );

    expect(await readCliConfig()).toEqual({ apiUrl: 'https://old.example', currentProject: 'p1' });
    expect((await readCredentials())?.email).toBe('a@example.com');

    await updateCliConfig({ currentProject: 'p2' });
    expect(JSON.parse(await readFile(join(home, '.swalvo', 'config.json'), 'utf8')).currentProject).toBe('p2');
    expect(JSON.parse(await readFile(join(home, '.raven', 'config.json'), 'utf8')).currentProject).toBe('p1');
    expect((await readCliConfig()).currentProject).toBe('p2');
    // Credentials are still found in ~/.raven after config moved over.
    expect((await readCredentials())?.email).toBe('a@example.com');

    await clearCredentials();
    expect(await readCredentials()).toBeUndefined();
  });

  it('honours $RAVEN_CONFIG_DIR with one deprecation notice', () => {
    process.env.RAVEN_CONFIG_DIR = join(home, 'custom');
    expect(swalvoHomeDir()).toBe(join(home, 'custom'));
    expect(swalvoHomeDir()).toBe(join(home, 'custom'));
    expect(stderr.filter((line) => line.includes('RAVEN_CONFIG_DIR is deprecated'))).toHaveLength(1);
  });

  it('reads $RAVEN_TOKEN and $RAVEN_API_URL / $LIVQENO_API_URL, with $SWALVO_* taking precedence', async () => {
    process.env.RAVEN_TOKEN = 'legacy-token';
    expect(credentialsFromEnv('http://api')?.token).toBe('legacy-token');

    process.env.LIVQENO_API_URL = 'https://livqeno.example';
    expect((await readCliConfig()).apiUrl).toBe('https://livqeno.example');
    process.env.RAVEN_API_URL = 'https://raven.example';
    expect((await readCliConfig()).apiUrl).toBe('https://raven.example');
    process.env.SWALVO_API_URL = 'https://swalvo.example';
    expect((await readCliConfig()).apiUrl).toBe('https://swalvo.example');
  });

  it('falls back to a raven.json project link, preferring swalvo.json', async () => {
    await writeFile(join(home, 'raven.json'), JSON.stringify({ project: 'legacy' }));
    expect(await readProjectConfig(home)).toEqual({ project: 'legacy' });
    await writeFile(join(home, 'swalvo.json'), JSON.stringify({ project: 'current' }));
    expect(await readProjectConfig(home)).toEqual({ project: 'current' });
  });
});
