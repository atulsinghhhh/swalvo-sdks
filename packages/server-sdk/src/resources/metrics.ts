import type { SwalvoHttpClient } from '../http-client';
import type { MetricsOverview, MetricsRange } from '../types';

/**
 * Real aggregate metrics only (Phase 9). This doubles as today's "usage"
 * view, since no separate billing or usage-metering system exists yet. See
 * docs/sdk/server/typescript.md#usage.
 */
export class MetricsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  get(range?: MetricsRange): Promise<MetricsOverview> {
    return this.http.request<MetricsOverview>('/v1/metrics', { query: { range } });
  }
}
