import type { SwalvoHttpClient } from '../http-client';
import type { ProjectDiagnostics } from '../types';

/**
 * Authenticated, project-scoped diagnostics (Phase 9): signaling, SFU and
 * TURN health, plus this project's real active-connection count.
 *
 * Nothing client-side in here. Browser ICE and signaling state only exist
 * inside a running `@swalvo/rtc` client, via `room.getDiagnostics()`, and
 * a backend has no way to observe that.
 */
export class DiagnosticsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  get(): Promise<ProjectDiagnostics> {
    return this.http.request<ProjectDiagnostics>('/v1/diagnostics');
  }
}
