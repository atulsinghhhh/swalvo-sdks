import type { SwalvoHttpClient } from '../http-client';
import type { ConnectionDetail, ConnectionSummary, ListConnectionsParams } from '../types';

/** Real event-sourced RTC connection data (Phase 9 observability), read from your backend. */
export class ConnectionsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  list(params: ListConnectionsParams = {}): Promise<ConnectionSummary[]> {
    return this.http.request<ConnectionSummary[]>('/v1/connections', {
      query: { roomId: params.roomId, state: params.state, limit: params.limit },
    });
  }

  get(connectionId: string): Promise<ConnectionDetail> {
    return this.http.request<ConnectionDetail>(`/v1/connections/${connectionId}`);
  }
}
