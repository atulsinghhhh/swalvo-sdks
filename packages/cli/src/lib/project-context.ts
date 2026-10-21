import { noProjectSelectedError } from './errors.js';
import { readCliConfig } from './cli-config.js';
import { readProjectConfig } from './project-config.js';

/**
 * Resolution order: explicit --project flag wins, then this dir's
 * swalvo.json (from `swalvo init`), then the global default from
 * `swalvo projects use`.
 */
export async function resolveProjectId(explicitProjectId?: string): Promise<string> {
  if (explicitProjectId) return explicitProjectId;

  const projectConfig = await readProjectConfig();
  if (projectConfig?.project) return projectConfig.project;

  const cliConfig = await readCliConfig();
  if (cliConfig.currentProject) return cliConfig.currentProject;

  throw noProjectSelectedError();
}
