import type { SwalvoApiClient } from './api-client.js';
import { CliError } from './errors.js';
import type { Project } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts either a project ID or a project name, the way the docs and the
 * dashboard both present a project. Names are matched exactly; a name two
 * projects share is ambiguous, so it asks for the ID instead of guessing.
 * Anything that isn't a known name is treated as an ID, so an unknown one
 * still gets the API's own "Project not found".
 */
export async function lookupProject(client: SwalvoApiClient, ref: string): Promise<Project> {
  if (UUID_PATTERN.test(ref)) return client.getProject(ref);

  const matches = (await client.listProjects()).filter((project) => project.name === ref);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CliError('usage', `${matches.length} projects are named "${ref}".`, {
      suggestion: `Use the project ID instead: ${matches.map((project) => project.id).join(', ')}`,
    });
  }
  return client.getProject(ref);
}
