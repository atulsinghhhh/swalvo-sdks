import { SwalvoHttpClient, type SwalvoClientOptions } from './http-client';
import { AgentsResource, TranscriptionsResource } from './resources/ai';
import { ChatResource } from './resources/chat';
import { ConnectionsResource } from './resources/connections';
import { DiagnosticsResource } from './resources/diagnostics';
import { ErrorsResource } from './resources/errors-resource';
import { LiveStreamsResource } from './resources/live-streams';
import { MetricsResource } from './resources/metrics';
import { ProjectsResource } from './resources/projects';
import { RoomsResource } from './resources/rooms';
import { TokensResource } from './resources/tokens';

/**
 * Swalvo's server SDK. For your backend only; never a browser bundle.
 *
 * Authenticates with a permanent project API key. Never expose that key,
 * or an instance of this class, to a browser (Phase 10 spec §2).
 *
 * ```ts
 * import { Swalvo } from '@swalvo/server';
 * const swalvo = new Swalvo({
 *   apiKey: process.env.SWALVO_API_KEY!,
 *   baseUrl: process.env.SWALVO_API_URL!, // https://api.swalvo.com
 * });
 * const token = await swalvo.tokens.create({ room: roomId, identity: 'user-42' });
 * ```
 */
export class Swalvo {
  readonly projects: ProjectsResource;
  readonly tokens: TokensResource;
  readonly rooms: RoomsResource;
  readonly connections: ConnectionsResource;
  readonly errors: ErrorsResource;
  readonly metrics: MetricsResource;
  readonly diagnostics: DiagnosticsResource;
  /** Swalvo Chat (Phase 12): mint browser tokens, manage conversations, post server-side messages. */
  readonly chat: ChatResource;
  /** Swalvo Live Streaming (Phase 14): create streams, register hosts, mint viewer credentials. */
  readonly liveStreams: LiveStreamsResource;
  /**
   * `liveStreams` under the shorter name, so the three product surfaces read
   * alike: `swalvo.chat`, `swalvo.live`, `swalvo.rooms`.
   *
   * The same object, not a wrapper — `swalvo.live === swalvo.liveStreams`, so
   * there is no second implementation to keep in step and no behaviour that
   * differs between the two spellings. `liveStreams` is the original public
   * name and keeps working; nothing is deprecated.
   */
  readonly live: LiveStreamsResource;
  /** Live transcription and transcripts (phase6-contracts.md §3.1). */
  readonly transcriptions: TranscriptionsResource;
  /** AI voice agents in a room (phase6-contracts.md §3.2). */
  readonly agents: AgentsResource;

  constructor(options: SwalvoClientOptions) {
    const http = new SwalvoHttpClient(options);
    this.projects = new ProjectsResource(http);
    this.tokens = new TokensResource(http);
    this.rooms = new RoomsResource(http);
    this.connections = new ConnectionsResource(http);
    this.errors = new ErrorsResource(http);
    this.metrics = new MetricsResource(http);
    this.diagnostics = new DiagnosticsResource(http);
    this.chat = new ChatResource(http);
    this.liveStreams = new LiveStreamsResource(http);
    this.live = this.liveStreams;
    this.transcriptions = new TranscriptionsResource(http);
    this.agents = new AgentsResource(http);
  }
}

/** @deprecated Renamed to {@link Swalvo}. Same class: `new Raven(...)` still works. */
export const Raven = Swalvo;
/** @deprecated Renamed to {@link Swalvo}. */
export type Raven = Swalvo;
