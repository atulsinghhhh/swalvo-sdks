import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LEGACY_PROJECT_CONFIG_FILENAME, PROJECT_CONFIG_FILENAME } from './paths.js';

export interface ProjectConfig {
  project: string;
}

/**
 * swalvo.json links this directory to a Swalvo project ID. Nothing but the ID
 * lives in it. No secrets, safe to commit.
 */
export async function readProjectConfig(cwd: string = process.cwd()): Promise<ProjectConfig | undefined> {
  // A directory linked before the Swalvo rename has a raven.json; it is read
  // when there's no swalvo.json, and left in place.
  for (const filename of [PROJECT_CONFIG_FILENAME, LEGACY_PROJECT_CONFIG_FILENAME]) {
    try {
      const raw = await readFile(join(cwd, filename), 'utf8');
      return JSON.parse(raw) as ProjectConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return undefined;
}

export async function writeProjectConfig(config: ProjectConfig, cwd: string = process.cwd()): Promise<string> {
  const path = join(cwd, PROJECT_CONFIG_FILENAME);
  await writeFile(path, JSON.stringify(config, null, 2) + '\n');
  return path;
}
