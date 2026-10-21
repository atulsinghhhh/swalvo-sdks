import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { debugLog } from './logger.js';
import type {
  ApiKeySummary,
  ChatConnectionSummary,
  ChatConversationSummary,
  ChatOverview,
  ChatPresenceEntry,
  ConnectionDetail,
  ConnectionLifecycleState,
  ConnectionSummary,
  CreatedApiKey,
  Environment,
  ErrorCategory,
  ErrorDetail,
  ErrorSummary,
  HealthResponse,
  IssuedRtcToken,
  LiveStreamStatus,
  LiveStreamSummary,
  LiveStreamVisibility,
  ObservabilityOverview,
  Project,
  ProjectDiagnostics,
  RoomDetailWithLiveState,
  RoomWithLiveState,
  RtcServer,
  RtcFleetMetrics,
} from './types.js';

const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 300;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Statuses that must never trigger a retry. Auth, authz, validation and not-found are never transient. */
  retryable?: boolean;
  /**
   * Overrides which HTTP statuses mean "return the body" rather than
   * "throw".
   *
   * Only /health needs it. The Control API returns 503 for a *structured,
   * still-parseable* degraded report, meaning some dependency is down, not
   * a failed request. Treat that as an error and you throw away the exact
   * information `swalvo status` exists to show.
   */
  isSuccess?: (status: number) => boolean;
}

/**
 * The one place that knows how to talk HTTP to the Control API. Every
 * command goes through it, and none of them builds a fetch() of its own
 * (Phase 8 spec §36).
 *
 * Handles auth, versioned paths, error mapping, limited retries, and
 * per-request correlation IDs for --debug tracing.
 */
export class SwalvoApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token?: string,
  ) {}

  async logout(): Promise<void> {
    await this.request<void>('/v1/auth/logout', { method: 'POST' });
  }

  async listProjects(): Promise<Project[]> {
    return this.request<Project[]>('/v1/projects');
  }

  async getProject(projectId: string): Promise<Project> {
    return this.request<Project>(`/v1/projects/${projectId}`);
  }

  async createProject(input: { name: string; description?: string }): Promise<Project> {
    return this.request<Project>('/v1/projects', { method: 'POST', body: input });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request<void>(`/v1/projects/${projectId}`, { method: 'DELETE' });
  }

  async listApiKeys(projectId: string): Promise<ApiKeySummary[]> {
    return this.request<ApiKeySummary[]>(`/v1/projects/${projectId}/api-keys`);
  }

  async createApiKey(projectId: string, input: { name?: string; environment?: Environment }): Promise<CreatedApiKey> {
    return this.request<CreatedApiKey>(`/v1/projects/${projectId}/api-keys`, { method: 'POST', body: input });
  }

  async revokeApiKey(projectId: string, keyId: string): Promise<void> {
    await this.request<void>(`/v1/projects/${projectId}/api-keys/${keyId}`, { method: 'DELETE' });
  }

  async listRooms(projectId: string): Promise<RoomWithLiveState[]> {
    return this.request<RoomWithLiveState[]>(`/v1/projects/${projectId}/rooms`);
  }

  async getRoom(projectId: string, roomId: string): Promise<RoomDetailWithLiveState> {
    return this.request<RoomDetailWithLiveState>(`/v1/projects/${projectId}/rooms/${roomId}`);
  }

  async createRoom(projectId: string, name: string): Promise<RoomWithLiveState> {
    return this.request<RoomWithLiveState>(`/v1/projects/${projectId}/rooms`, { method: 'POST', body: { name } });
  }

  async closeRoom(projectId: string, roomId: string): Promise<void> {
    await this.request<void>(`/v1/projects/${projectId}/rooms/${roomId}/close`, { method: 'POST' });
  }

  /**
   * The RTC fleet.
   *
   * Not project-scoped, unlike everything above. An RTC server is
   * deployment-level infrastructure shared by every project, so there's no
   * project whose membership could authorize it. It exposes no project data
   * either: node identity, health, aggregate load, and that's all.
   */
  async listRtcServers(region?: string): Promise<RtcServer[]> {
    const query = region ? `?region=${encodeURIComponent(region)}` : '';
    return this.request<RtcServer[]>(`/v1/rtc/servers${query}`);
  }

  async getRtcServer(name: string): Promise<RtcServer> {
    return this.request<RtcServer>(`/v1/rtc/servers/${encodeURIComponent(name)}`);
  }

  async getRtcFleetMetrics(): Promise<RtcFleetMetrics> {
    return this.request<RtcFleetMetrics>('/v1/rtc/servers/metrics');
  }

  async drainRtcServer(name: string, draining: boolean): Promise<RtcServer> {
    const action = draining ? 'drain' : 'undrain';
    return this.request<RtcServer>(`/v1/rtc/servers/${encodeURIComponent(name)}/${action}`, {
      method: 'POST',
    });
  }

  async createTestToken(projectId: string, roomId: string, participantIdentity?: string): Promise<IssuedRtcToken> {
    return this.request<IssuedRtcToken>(`/v1/projects/${projectId}/rooms/${roomId}/test-token`, {
      method: 'POST',
      body: { participantIdentity },
    });
  }

  async listConnections(
    projectId: string,
    opts: { state?: ConnectionLifecycleState; roomId?: string; limit?: number } = {},
  ): Promise<ConnectionSummary[]> {
    const params = new URLSearchParams();
    if (opts.state) params.set('state', opts.state);
    if (opts.roomId) params.set('roomId', opts.roomId);
    if (opts.limit) params.set('limit', String(opts.limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<ConnectionSummary[]>(`/v1/projects/${projectId}/connections${query}`);
  }

  async getConnection(projectId: string, connectionId: string): Promise<ConnectionDetail> {
    return this.request<ConnectionDetail>(`/v1/projects/${projectId}/connections/${connectionId}`);
  }

  async listErrors(
    projectId: string,
    opts: { category?: ErrorCategory; connectionId?: string; limit?: number } = {},
  ): Promise<ErrorSummary[]> {
    const params = new URLSearchParams();
    if (opts.category) params.set('category', opts.category);
    if (opts.connectionId) params.set('connectionId', opts.connectionId);
    if (opts.limit) params.set('limit', String(opts.limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<ErrorSummary[]>(`/v1/projects/${projectId}/errors${query}`);
  }

  async getError(projectId: string, errorId: string): Promise<ErrorDetail> {
    return this.request<ErrorDetail>(`/v1/projects/${projectId}/errors/${errorId}`);
  }

  async getMetrics(projectId: string, range?: string): Promise<ObservabilityOverview> {
    const query = range ? `?range=${encodeURIComponent(range)}` : '';
    return this.request<ObservabilityOverview>(`/v1/projects/${projectId}/metrics${query}`);
  }

  async getDiagnostics(projectId: string): Promise<ProjectDiagnostics> {
    return this.request<ProjectDiagnostics>(`/v1/projects/${projectId}/diagnostics`);
  }

  async getChatOverview(projectId: string, range?: string): Promise<ChatOverview> {
    const query = range ? `?range=${encodeURIComponent(range)}` : '';
    return this.request<ChatOverview>(`/v1/projects/${projectId}/chat/overview${query}`);
  }

  async listChatConversations(projectId: string): Promise<ChatConversationSummary[]> {
    return this.request<ChatConversationSummary[]>(`/v1/projects/${projectId}/chat/conversations`);
  }

  async listChatConnections(
    projectId: string,
    opts: { state?: ConnectionLifecycleState; limit?: number } = {},
  ): Promise<ChatConnectionSummary[]> {
    const params = new URLSearchParams();
    if (opts.state) params.set('state', opts.state);
    if (opts.limit) params.set('limit', String(opts.limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<ChatConnectionSummary[]>(`/v1/projects/${projectId}/chat/connections${query}`);
  }

  async getChatPresence(projectId: string, conversationId: string): Promise<ChatPresenceEntry[]> {
    return this.request<ChatPresenceEntry[]>(`/v1/projects/${projectId}/chat/conversations/${conversationId}/presence`);
  }

  async listStreams(projectId: string, status?: LiveStreamStatus): Promise<LiveStreamSummary[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request<LiveStreamSummary[]>(`/v1/projects/${projectId}/live-streams${query}`);
  }

  async getStream(projectId: string, streamId: string): Promise<LiveStreamSummary> {
    return this.request<LiveStreamSummary>(`/v1/projects/${projectId}/live-streams/${streamId}`);
  }

  async createStream(
    projectId: string,
    input: {
      title: string;
      hostIdentity: string;
      description?: string;
      thumbnailUrl?: string;
      category?: string;
      tags?: string[];
      language?: string;
      visibility?: LiveStreamVisibility;
    },
  ): Promise<LiveStreamSummary> {
    return this.request<LiveStreamSummary>(`/v1/projects/${projectId}/live-streams`, {
      method: 'POST',
      body: input,
    });
  }

  async updateStream(
    projectId: string,
    streamId: string,
    input: {
      title?: string;
      description?: string;
      thumbnailUrl?: string;
      category?: string;
      tags?: string[];
      language?: string;
      visibility?: LiveStreamVisibility;
    },
  ): Promise<LiveStreamSummary> {
    return this.request<LiveStreamSummary>(`/v1/projects/${projectId}/live-streams/${streamId}`, {
      method: 'PATCH',
      body: input,
    });
  }

  async endStream(projectId: string, streamId: string): Promise<LiveStreamSummary> {
    return this.request<LiveStreamSummary>(`/v1/projects/${projectId}/live-streams/${streamId}/end`, {
      method: 'POST',
    });
  }

  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health', {
      retryable: false,
      isSuccess: (status) => status === 200 || status === 503,
    });
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const requestId = randomUUID();
    const method = options.method ?? 'GET';
    const url = `${this.apiUrl}${path}`;
    const retryable = options.retryable ?? true;

    let attempt = 0;
    while (true) {
      debugLog(`→ ${method} ${path}`, { requestId, body: options.body });

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
      } catch (error) {
        if (retryable && attempt < MAX_RETRIES) {
          await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new CliError('network', `Could not reach the Swalvo API at ${this.apiUrl}.`, {
          suggestion: 'Check your network connection and `swalvo config get apiUrl`',
          cause: error,
        });
      }

      debugLog(`← ${response.status} ${method} ${path}`, { requestId });

      if (response.status === 204) return undefined as T;

      const payload = await response.json().catch(() => undefined);
      const isSuccess = options.isSuccess ?? ((status: number) => status >= 200 && status < 300);

      if (isSuccess(response.status)) return payload as T;

      // 5xx is the only class worth retrying. A 4xx is never transient.
      if (retryable && response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
        attempt++;
        continue;
      }

      throw mapErrorResponse(response.status, payload);
    }
  }
}

function mapErrorResponse(status: number, payload: unknown): CliError {
  const message = extractMessage(payload) ?? `Request failed with status ${status}`;

  if (status === 401) {
    return new CliError('auth', message, {
      suggestion: 'Run `swalvo login`, or set SWALVO_TOKEN if there is no browser here',
    });
  }
  if (status === 403) {
    return new CliError('authz', message);
  }
  if (status === 404) {
    return new CliError('not_found', message);
  }
  if (status === 429) {
    return new CliError('network', 'Rate limit exceeded; try again shortly.');
  }
  if (status >= 500) {
    return new CliError('network', message, { suggestion: 'Try again in a moment' });
  }
  return new CliError('usage', message);
}

function extractMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const message = (payload as Record<string, unknown>).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
