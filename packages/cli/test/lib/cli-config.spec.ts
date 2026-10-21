import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_API_URL,
  isConfigKey,
  readCliConfig,
  updateCliConfig,
  writeCliConfig,
} from '../../src/lib/cli-config.js';

describe('cli-config', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'swalvo-cli-config-'));
    process.env.SWALVO_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.SWALVO_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to the local API URL with no currentProject when no file exists yet', async () => {
    const config = await readCliConfig();
    expect(config).toEqual({ apiUrl: DEFAULT_API_URL });
  });

  it('round-trips a written config', async () => {
    await writeCliConfig({ apiUrl: 'https://api.example.com', currentProject: 'proj-1' });
    const config = await readCliConfig();
    expect(config).toEqual({ apiUrl: 'https://api.example.com', currentProject: 'proj-1' });
  });

  it('updateCliConfig merges a partial patch onto the existing config', async () => {
    await writeCliConfig({ apiUrl: 'https://api.example.com' });
    const updated = await updateCliConfig({ currentProject: 'proj-2' });
    expect(updated).toEqual({ apiUrl: 'https://api.example.com', currentProject: 'proj-2' });
  });

  it('never contains a "token" or "credentials" field; the config file must never carry secrets', async () => {
    await writeCliConfig({ apiUrl: 'https://api.example.com', currentProject: 'proj-1' });
    const config = await readCliConfig();
    expect(config).not.toHaveProperty('token');
    expect(config).not.toHaveProperty('credentials');
  });
});

describe('isConfigKey', () => {
  it('accepts only the documented config keys', () => {
    expect(isConfigKey('apiUrl')).toBe(true);
    expect(isConfigKey('currentProject')).toBe(true);
    expect(isConfigKey('token')).toBe(false);
    expect(isConfigKey('secret')).toBe(false);
  });
});
