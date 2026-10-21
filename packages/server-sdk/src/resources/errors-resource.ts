import type { SwalvoHttpClient } from '../http-client';
import type { ErrorDetail, ErrorSummary, ListErrorsParams } from '../types';

/** Classified RTC errors. Never a raw SFU or coturn error code. See docs/error-codes.md. */
export class ErrorsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  list(params: ListErrorsParams = {}): Promise<ErrorSummary[]> {
    return this.http.request<ErrorSummary[]>('/v1/errors', {
      query: { category: params.category, connectionId: params.connectionId, limit: params.limit },
    });
  }

  get(errorId: string): Promise<ErrorDetail> {
    return this.http.request<ErrorDetail>(`/v1/errors/${errorId}`);
  }
}
