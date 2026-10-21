import type { SwalvoHttpClient } from '../http-client';
import type { Project } from '../types';

/**
 * An API key is already permanently scoped to exactly one project (Phase 10
 * spec §2/§14), so there's nothing to list, create, update or delete here.
 * Those stay human, dashboard-session operations; not something a server
 * API key can or should do.
 *
 * `get()` takes no arguments. It always returns the one project this key
 * belongs to.
 */
export class ProjectsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  /** Returns the project this API key belongs to. */
  get(): Promise<Project> {
    return this.http.request<Project>('/v1/project');
  }
}
