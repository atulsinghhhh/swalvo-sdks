import type { SwalvoHttpClient } from '../http-client';
import type {
  Agent,
  CreateAgentParams,
  StartTranscriptionParams,
  Transcription,
  TranscriptPage,
  UpdateAgentParams,
} from '../types';

const enc = encodeURIComponent;

/**
 * Live transcription (one per room) and its stored transcript.
 *
 * ```ts
 * const trx = await swalvo.transcriptions.start(roomId, { language: 'en' });
 * // ...later
 * await swalvo.transcriptions.stop(roomId);
 * const vtt = await swalvo.transcriptions.export(trx.id, 'vtt');
 * ```
 */
export class TranscriptionsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  /** Not retried: a retry after a lost response would hit the one-per-room 409. */
  start(roomId: string, params: StartTranscriptionParams = {}): Promise<Transcription> {
    return this.http.request<Transcription>(`/v1/rooms/${enc(roomId)}/transcription`, {
      method: 'POST',
      body: params,
      retryable: false,
    });
  }

  /** The room's active transcription; a 404 `SwalvoError` when there is none. */
  get(roomId: string): Promise<Transcription> {
    return this.http.request<Transcription>(`/v1/rooms/${enc(roomId)}/transcription`);
  }

  stop(roomId: string): Promise<void> {
    return this.http.request<void>(`/v1/rooms/${enc(roomId)}/transcription`, { method: 'DELETE' });
  }

  /** One page of final segments; pass `nextCursor` back as `cursor` for the next. */
  transcript(transcriptionId: string, params: { cursor?: string; limit?: number } = {}): Promise<TranscriptPage> {
    return this.http.request<TranscriptPage>(`/v1/transcripts/${enc(transcriptionId)}`, { query: params });
  }

  /** The whole transcript as WebVTT or plain text. */
  export(transcriptionId: string, format: 'vtt' | 'txt'): Promise<string> {
    return this.http.request<string>(`/v1/transcripts/${enc(transcriptionId)}.${format}`, { responseType: 'text' });
  }

  /** GDPR: delete every stored segment this participant identity spoke. */
  eraseParticipant(identity: string): Promise<{ participantId: string; deleted: number }> {
    return this.http.request(`/v1/transcripts/participants/${enc(identity)}`, { method: 'DELETE' });
  }
}

/** AI voice agents: an LLM that listens and speaks in a room. */
export class AgentsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  /** Not retried: a retry after a lost response would start a second agent. */
  create(roomId: string, params: CreateAgentParams): Promise<Agent> {
    return this.http.request<Agent>(`/v1/rooms/${enc(roomId)}/agents`, {
      method: 'POST',
      body: params,
      retryable: false,
    });
  }

  list(roomId: string): Promise<Agent[]> {
    return this.http.request<Agent[]>(`/v1/rooms/${enc(roomId)}/agents`);
  }

  get(agentId: string): Promise<Agent> {
    return this.http.request<Agent>(`/v1/agents/${enc(agentId)}`);
  }

  /** Applied live: new instructions, who it listens to, whether it can be interrupted. */
  update(agentId: string, params: UpdateAgentParams): Promise<Agent> {
    return this.http.request<Agent>(`/v1/agents/${enc(agentId)}`, { method: 'PATCH', body: params });
  }

  /** Speak this text now, after the current utterance. */
  say(agentId: string, text: string): Promise<void> {
    return this.http.request<void>(`/v1/agents/${enc(agentId)}/say`, {
      method: 'POST',
      body: { text },
      retryable: false,
    });
  }

  /** Stop the current utterance. */
  interrupt(agentId: string): Promise<void> {
    return this.http.request<void>(`/v1/agents/${enc(agentId)}/interrupt`, { method: 'POST' });
  }

  delete(agentId: string): Promise<void> {
    return this.http.request<void>(`/v1/agents/${enc(agentId)}`, { method: 'DELETE' });
  }
}
