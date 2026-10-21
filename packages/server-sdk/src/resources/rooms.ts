import type { SwalvoHttpClient } from '../http-client';
import type {
  LiveParticipantPermissions,
  LiveParticipantInfo,
  MuteParticipantParams,
  ParticipantMetadataResult,
  Room,
  SendDataOptions,
  UpdateParticipantParams,
  UpdateParticipantPermissionsParams,
} from '../types';

const encode = encodeURIComponent;

/**
 * Rooms are control-plane records, not persistent infrastructure. So
 * `delete()` closes a room, a soft-close setting status to CLOSED, rather
 * than destroying history. Matches what the API actually does (Phase 10
 * spec §18).
 */
export class RoomsResource {
  readonly participants: RoomParticipantsResource;

  constructor(private readonly http: SwalvoHttpClient) {
    this.participants = new RoomParticipantsResource(http);
  }

  list(): Promise<Room[]> {
    return this.http.request<Room[]>('/v1/rooms');
  }

  get(roomId: string): Promise<Room> {
    return this.http.request<Room>(`/v1/rooms/${roomId}`);
  }

  /**
   * `getOrCreate` matters for the ordinary multi-client case: two
   * participants both calling `create({ name: roomId })` for the room
   * they're both about to join. Without it, the loser of that race gets a
   * 409 instead of a Room — pass `getOrCreate: true` so it gets the
   * winner's room back instead.
   *
   * `e2ee: true` makes the room end-to-end encrypted: media is encrypted
   * in the client SDKs with keys Swalvo never sees, RTC tokens for the
   * room carry `e2ee: true`, and server-side processing that needs
   * plaintext (HLS/recording/restream egress, ingress) is refused with
   * `E2EE_NOT_SUPPORTED`. Fixed for the room's life; with `getOrCreate`, a
   * mismatch against an existing room is a 409, never a silent downgrade.
   */
  create(params: { name: string; getOrCreate?: boolean; e2ee?: boolean }): Promise<Room> {
    return this.http.request<Room>('/v1/rooms', { method: 'POST', body: params });
  }

  /** Soft-closes the room, setting status to CLOSED. Never a hard delete. */
  delete(roomId: string): Promise<void> {
    return this.http.request<void>(`/v1/rooms/${roomId}`, { method: 'DELETE' });
  }

  // --- Server moderation of a live room -------------------------------------
  // `roomId` takes the room's id or its name. Every method needs the
  // participant to be connected right now; one who is not is a 404
  // (`RAVEN_PARTICIPANT_NOT_CONNECTED`).

  /**
   * Removes a participant from the live room: every session of that identity
   * gets `room.left { reason: 'REMOVED' }` and is closed. Their token is not
   * revoked, so revoke it as well to keep them out.
   */
  removeParticipant(roomId: string, identity: string): Promise<void> {
    return this.http.request<void>(`/v1/rooms/${encode(roomId)}/participants/${encode(identity)}/remove`, {
      method: 'POST',
    });
  }

  /**
   * Mutes or unmutes one track (`trackId`) or every track of a kind (`kind`)
   * a participant publishes. The participant is told the mute came from the
   * server.
   */
  muteParticipant(roomId: string, identity: string, params: MuteParticipantParams): Promise<void> {
    if (!params || (!('trackId' in params && params.trackId) && !('kind' in params && params.kind))) {
      return Promise.reject(
        new TypeError('muteParticipant needs one of trackId or kind, e.g. { kind: "audio", muted: true }'),
      );
    }
    return this.http.request<void>(`/v1/rooms/${encode(roomId)}/participants/${encode(identity)}/mute`, {
      method: 'POST',
      body: params,
    });
  }

  /**
   * Changes a connected participant's permissions in place, merging into
   * what they have now. Returns the resulting permissions. Changes no issued
   * token.
   */
  updateParticipantPermissions(
    roomId: string,
    identity: string,
    permissions: UpdateParticipantPermissionsParams,
  ): Promise<LiveParticipantPermissions> {
    return this.http.request<LiveParticipantPermissions>(
      `/v1/rooms/${encode(roomId)}/participants/${encode(identity)}/permissions`,
      { method: 'PATCH', body: permissions },
    );
  }

  /**
   * Replaces a connected participant's `metadata` and/or merges into their
   * `attributes` (an attribute set to `null` is deleted). Everyone in the
   * room receives `participant.updated`. Returns the resulting values.
   */
  updateParticipant(
    roomId: string,
    identity: string,
    params: UpdateParticipantParams,
  ): Promise<ParticipantMetadataResult> {
    return this.http.request<ParticipantMetadataResult>(
      `/v1/rooms/${encode(roomId)}/participants/${encode(identity)}`,
      { method: 'PATCH', body: params },
    );
  }

  /**
   * Sends a data message into the room from the server. Recipients get it
   * through their SDK's data event with no sender participant, which means
   * the server. Up to 64 KiB on the reliable channel (the default), 1,200
   * bytes with `reliable: false`. Best-effort, like any data-channel
   * message, and never retried by this SDK, so a retry can't deliver it
   * twice.
   */
  sendData(
    roomId: string,
    payload: Uint8Array | string,
    options: SendDataOptions = {},
  ): Promise<{ messageId: string }> {
    const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
    return this.http.request<{ messageId: string }>(`/v1/rooms/${encode(roomId)}/data`, {
      method: 'POST',
      retryable: false,
      body: {
        payload: bytes.toString('base64'),
        ...(options.topic !== undefined ? { topic: options.topic } : {}),
        ...(options.destinationIdentities !== undefined
          ? { destinationIdentities: options.destinationIdentities }
          : {}),
        ...(options.reliable !== undefined ? { reliable: options.reliable } : {}),
      },
    });
  }
}

/**
 * Real join/leave participant *history* isn't wired up in the Control API
 * yet. This always reflects the SFU's current live state (Phase 10 §19),
 * never a stored roster.
 *
 * `null` means the SFU couldn't be reached. That's a different thing from a
 * genuinely empty room (`[]`), and the two never get collapsed into one
 * number.
 */
export class RoomParticipantsResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  async list(roomId: string): Promise<LiveParticipantInfo[] | null> {
    return this.http.request<LiveParticipantInfo[] | null>(`/v1/rooms/${roomId}/participants`);
  }

  async get(roomId: string, identity: string): Promise<LiveParticipantInfo | null> {
    const participants = await this.list(roomId);
    return participants?.find((p) => p.identity === identity) ?? null;
  }
}
