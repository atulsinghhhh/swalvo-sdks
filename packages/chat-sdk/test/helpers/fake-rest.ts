/**
 * A stand-in for the REST API, routed by method and path.
 *
 * The Phase 3 endpoints are being built server-side at the same time as
 * this SDK, against the same contract (docs/architecture/phase3-chat-contracts.md),
 * so these tests pin the SDK to the contract rather than to a server that
 * may not exist yet.
 */
export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type RouteHandler = (
  call: RecordedCall,
) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

export class FakeRest {
  readonly calls: RecordedCall[] = [];
  /** While true, every request fails at the network layer, the way `fetch` does when offline. */
  offline = false;
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [];

  constructor() {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (input: string, init: RequestInit = {}) => {
      if (this.offline) throw new TypeError('Failed to fetch');
      const url = new URL(String(input));
      const call: RecordedCall = {
        method: init.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      this.calls.push(call);
      const route = this.routes.find(
        (candidate) => candidate.method === call.method && candidate.pattern.test(call.path),
      );
      if (!route) {
        return respond(404, {
          code: 'RAVEN_NOT_FOUND',
          legacyCode: 'ROOM_NOT_FOUND',
          message: `no route for ${call.method} ${call.path}`,
        });
      }
      const result = await route.handler(call);
      return respond(result.status ?? 200, result.body);
    });
  }

  on(method: string, pattern: RegExp, handler: RouteHandler): this {
    this.routes.unshift({ method, pattern, handler });
    return this;
  }

  /** Every call to a path matching `pattern`. */
  callsTo(pattern: RegExp, method?: string): RecordedCall[] {
    return this.calls.filter((call) => pattern.test(call.path) && (method === undefined || call.method === method));
  }
}

function respond(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}
