/**
 * Swalvo's signaling wire protocol, as the client sees it.
 *
 * Mirrors `apps/api/src/modules/signaling/signaling.constants.ts` and
 * `interfaces/signaling-message.interface.ts`. Written out by hand rather
 * than imported, so the SDK carries no dependency on the server package.
 * Three client implementations speak this (web, React Native, Flutter) and
 * the contract has to stand on its own.
 *
 * Warning if you're reading older code: most of the message *names*
 * survived the move off the old full-mesh protocol, but their meanings
 * didn't. `targetParticipantId` is gone. A client has exactly one peer
 * now: the SFU serving its room.
 */

export const ClientMessageType = {
  ROOM_JOIN: 'room.join',
  ROOM_LEAVE: 'room.leave',
  SDP_ANSWER: 'sdp.answer',
  SDP_OFFER: 'sdp.offer',
  ICE_CANDIDATE: 'ice.candidate',
  TRACK_MUTE: 'track.mute',
  /**
   * Declares what a track being published is *of*.
   *
   * Needed because WebRTC has no such concept, and a page can't choose the
   * `MediaStream` or `MediaStreamTrack` id the SDP will carry; both are
   * read-only. Without this the SFU can only guess the source from codec
   * kind, and that can't tell a screen share from a camera.
   */
  TRACK_PUBLISH: 'track.publish',
  SUBSCRIPTION_UPDATE: 'subscription.update',
  /** A fresh RTC token for the live session (docs/architecture/phase1-contracts.md §1.1). */
  TOKEN_REFRESH: 'token.refresh',
  /** Phase 7 §2: this participant's own metadata/attributes (needs `perms.updateOwnMetadata`). */
  PARTICIPANT_UPDATE: 'participant.update',
  PING: 'ping',
} as const;

export const ServerMessageType = {
  ROOM_JOINED: 'room.joined',
  ROOM_LEFT: 'room.left',
  PARTICIPANT_JOINED: 'participant.joined',
  PARTICIPANT_LEFT: 'participant.left',
  TRACK_PUBLISHED: 'track.published',
  TRACK_UNPUBLISHED: 'track.unpublished',
  TRACK_MUTED: 'track.muted',
  TRACK_UNMUTED: 'track.unmuted',
  SDP_OFFER: 'sdp.offer',
  SDP_ANSWER: 'sdp.answer',
  ICE_CANDIDATE: 'ice.candidate',
  CONNECTION_STATE: 'connection.state',
  ERROR: 'error',
  PONG: 'pong',
  // Phase 1 resilience additions (docs/architecture/phase1-contracts.md §1).
  // Additive: a server that predates them simply never sends them.
  TOKEN_EXPIRING: 'token.expiring',
  TOKEN_REFRESHED: 'token.refreshed',
  ROOM_RESUME_TOKEN: 'room.resume_token',
  PARTICIPANT_PERMISSIONS_UPDATED: 'participant.permissions_updated',
  // Phase 2 media-quality additions (docs/architecture/phase2-media-contracts.md).
  // Additive like the Phase 1 set: an older server never sends them.
  /** §2: the room's ordered active-speaker set changed. */
  SPEAKERS_CHANGED: 'speakers.changed',
  /** §3: one or more participants' connection-quality scores changed. */
  QUALITY_CHANGED: 'quality.changed',
  /** §4: one of this subscriber's tracks changed forwarding state or layer. */
  SUBSCRIPTION_STATE: 'subscription.state',
  /** §5: which simulcast layers of a published track anyone is receiving. */
  PUBLISHER_LAYERS: 'publisher.layers',
  // Phase 7 additions (docs/architecture/phase7-contracts.md). Additive.
  /** §2: someone's metadata or attributes changed. */
  PARTICIPANT_UPDATED: 'participant.updated',
  /** §1.4: the SFU dropped some of this participant's data messages over the rate limit. */
  DATA_THROTTLED: 'data.throttled',
  // Phase 6 additions (docs/architecture/phase6-contracts.md §4). Additive.
  /** §4.1: a live caption, interim (replaced by the next with its segmentId) or final. */
  TRANSCRIPTION_SEGMENT: 'transcription.segment',
  /** §4.3: the room's transcription changed status. */
  TRANSCRIPTION_STATE: 'transcription.state',
  /** §4.2: an AI agent in the room is listening, thinking, speaking, or has ended. */
  AGENT_STATE: 'agent.state',
} as const;

export type SignalingErrorCode =
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'UNAUTHORIZED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'INVALID_MESSAGE'
  | 'INVALID_MESSAGE_TYPE'
  | 'PARTICIPANT_NOT_FOUND'
  | 'NOT_IN_ROOM'
  | 'PERMISSION_DENIED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'USAGE_LIMIT_EXCEEDED'
  | 'NO_RTC_CAPACITY'
  | 'RTC_SERVER_UNREACHABLE'
  | 'NEGOTIATION_FAILED'
  | 'NEGOTIATION_GLARE'
  /** A `token.refresh` was refused. Non-fatal: the session carries on under its old token (§1.1). */
  | 'TOKEN_INVALID'
  /** The room was closed server-side; the socket closes with 4003 straight after. */
  | 'ROOM_CLOSED';

/**
 * Why the server ended this participant's session, from `room.left`
 * (§1.5). Absent on a leave the client asked for itself.
 */
export type ServerLeaveReason = 'REMOVED' | 'ROOM_CLOSED' | 'TOKEN_EXPIRED';

/** A session's live permissions, as `participant.permissions_updated` carries them (§1.4). */
export interface ServerPermissions {
  subscribe: boolean;
  publish: boolean;
  publishAudio: boolean;
  publishVideo: boolean;
  /**
   * Screen-share, independent of publishVideo (agora-parity audit, phase
   * 2). Optional like updateOwnMetadata below: absent from an older
   * server during a rolling deploy means false, not "unspecified".
   */
  publishScreen?: boolean;
  publishData: boolean;
  /** Phase 7 §2. Absent from older servers, which means "as the token said". */
  updateOwnMetadata?: boolean;
}

/**
 * WebSocket close codes the client acts on. The 4xxx range is the
 * application's own (RFC 6455 §7.4.2); 1012 is the standard "service
 * restart".
 */
export const CloseCode = {
  /** The API is shutting down gracefully. Reconnect now, with resume (§1.3). */
  SERVICE_RESTART: 1012,
  /** Authentication failed, or the token expired with enforcement on (§1.1). */
  AUTH_FAILED: 4001,
  /** Another connection for the same identity took over. Reconnecting would evict it. */
  REPLACED: 4002,
  /** Removed by the server, or the room was closed. Never auto-reconnect (§1.5). */
  REMOVED: 4003,
} as const;

export interface ServerTrack {
  trackId: string;
  kind: 'audio' | 'video';
  source: string;
  muted: boolean;
  simulcast: boolean;
  layers?: string[];
}

/** One entry of `speakers.changed` (§2). `level` is 0..1. */
export interface ServerSpeaker {
  participantId: string;
  level: number;
}

/** The SFU's per-participant score (§3). */
export type ServerConnectionQuality = 'excellent' | 'good' | 'poor' | 'lost';

/** Forwarding state of one subscription (§4). */
export type ServerSubscriptionState = 'active' | 'paused_bandwidth' | 'paused_client';

/**
 * A layer a subscriber may ask for. `'off'` (§4) asks the SFU to stop
 * forwarding the video without tearing the subscription down.
 */
export type SubscriptionLayer = 'low' | 'medium' | 'high' | 'auto' | 'off';

export interface ServerParticipant {
  id: string;
  tracks?: ServerTrack[];
  /** Phase 7 §2. Opaque application string; absent from older servers. */
  metadata?: string | null;
  /** Phase 7 §2. Absent from older servers. */
  attributes?: Record<string, string> | null;
}

export type ServerMessage =
  | {
      type: typeof ServerMessageType.ROOM_JOINED;
      roomId: string;
      participants: ServerParticipant[];
      rtcServer?: string;
      region?: string;
      /** Opaque; handed back in `room.join` after a socket drop (§1.2). */
      resumeToken?: string;
      /** Present on a join that carried `resume`: whether the old SFU session was kept. */
      resumed?: boolean;
      /** The room is end-to-end encrypted (phase5-contracts §3.1): unencrypted media must not be published. */
      e2ee?: boolean;
      /** Phase 7: optional features this server supports, such as `data.v2`. Older servers omit it. */
      capabilities?: string[];
    }
  | { type: typeof ServerMessageType.ROOM_LEFT; roomId?: string; reason?: ServerLeaveReason }
  | { type: typeof ServerMessageType.PARTICIPANT_JOINED; participant: ServerParticipant }
  | { type: typeof ServerMessageType.PARTICIPANT_LEFT; participant: ServerParticipant }
  | { type: typeof ServerMessageType.TRACK_PUBLISHED; participantId: string; track: ServerTrack }
  | { type: typeof ServerMessageType.TRACK_UNPUBLISHED; participantId: string; trackId: string }
  | {
      type: typeof ServerMessageType.TRACK_MUTED;
      participantId: string;
      trackId: string;
      /** Set only on the copy sent to the muted participant itself, when the server did the muting (§1.6). */
      byServer?: boolean;
    }
  | { type: typeof ServerMessageType.TRACK_UNMUTED; participantId: string; trackId: string }
  | { type: typeof ServerMessageType.SDP_OFFER; sdp: string }
  | { type: typeof ServerMessageType.SDP_ANSWER; sdp: string }
  | {
      type: typeof ServerMessageType.ICE_CANDIDATE;
      candidate: string;
      sdpMid?: string;
      sdpMLineIndex?: number;
      usernameFragment?: string;
    }
  | { type: typeof ServerMessageType.CONNECTION_STATE; iceState: string; peerState: string }
  | { type: typeof ServerMessageType.ERROR; code: SignalingErrorCode; message: string }
  | { type: typeof ServerMessageType.PONG }
  | { type: typeof ServerMessageType.TOKEN_EXPIRING; expiresAt: string }
  | { type: typeof ServerMessageType.TOKEN_REFRESHED; expiresAt: string }
  | { type: typeof ServerMessageType.ROOM_RESUME_TOKEN; resumeToken: string }
  | { type: typeof ServerMessageType.PARTICIPANT_PERMISSIONS_UPDATED; permissions: ServerPermissions }
  | { type: typeof ServerMessageType.SPEAKERS_CHANGED; speakers: ServerSpeaker[] }
  | {
      type: typeof ServerMessageType.QUALITY_CHANGED;
      updates: { participantId: string; quality: ServerConnectionQuality }[];
    }
  | {
      type: typeof ServerMessageType.SUBSCRIPTION_STATE;
      publisherId: string;
      trackId: string;
      state: ServerSubscriptionState;
      /** The layer being forwarded, in the SFU's names (`low`/`medium`/`high`). */
      layer?: string;
    }
  | {
      type: typeof ServerMessageType.PUBLISHER_LAYERS;
      trackId: string;
      layers: { rid: string; active: boolean }[];
    }
  | {
      type: typeof ServerMessageType.PARTICIPANT_UPDATED;
      participantId: string;
      metadata?: string | null;
      attributes?: Record<string, string> | null;
    }
  | { type: typeof ServerMessageType.DATA_THROTTLED; channel: 'reliable' | 'lossy' }
  | {
      type: typeof ServerMessageType.TRANSCRIPTION_SEGMENT;
      /** Null for an agent's own speech when no transcription runs. */
      transcriptionId: string | null;
      agentId?: string;
      participantId: string;
      segmentId: string;
      text: string;
      final: boolean;
      language: string;
      startMs: number;
      endMs: number;
    }
  | {
      type: typeof ServerMessageType.TRANSCRIPTION_STATE;
      transcriptionId: string;
      status: string;
      language: string;
    }
  | { type: typeof ServerMessageType.AGENT_STATE; agentId: string; participantId: string; state: string };

export type ClientMessage =
  | {
      type: typeof ClientMessageType.ROOM_JOIN;
      roomId?: string;
      region?: string;
      /** Asks to re-bind the previous SFU session instead of allocating a new one (§1.2). */
      resume?: { token: string };
      /**
       * §4. Sent only as `false`: video subscriptions then start paused
       * (`paused_client`) until a layer is requested. Omitted means the
       * server default, true, which is also what an older server assumes.
       */
      autoSubscribe?: false;
    }
  | { type: typeof ClientMessageType.TOKEN_REFRESH; token: string }
  | { type: typeof ClientMessageType.ROOM_LEAVE }
  | { type: typeof ClientMessageType.SDP_ANSWER; sdp: string }
  | { type: typeof ClientMessageType.SDP_OFFER; sdp: string }
  | {
      type: typeof ClientMessageType.ICE_CANDIDATE;
      candidate: string;
      sdpMid?: string;
      sdpMLineIndex?: number;
      usernameFragment?: string;
    }
  | { type: typeof ClientMessageType.TRACK_MUTE; trackId: string; muted: boolean }
  | {
      type: typeof ClientMessageType.TRACK_PUBLISH;
      trackId: string;
      source: 'camera' | 'microphone' | 'screenShare' | 'screenShareAudio';
    }
  | {
      type: typeof ClientMessageType.PARTICIPANT_UPDATE;
      metadata?: string;
      attributes?: Record<string, string>;
    }
  | {
      type: typeof ClientMessageType.SUBSCRIPTION_UPDATE;
      publisherId: string;
      trackId: string;
      layer: SubscriptionLayer;
    }
  | { type: typeof ClientMessageType.PING };

/**
 * Error codes meaning "the credential is the problem", where reconnecting
 * on the same token can't possibly help.
 *
 * The split drives reconnect behaviour. Everything else is worth retrying
 * with backoff; these want a fresh token from the application's backend
 * first.
 */
export const FATAL_ERROR_CODES: ReadonlySet<SignalingErrorCode> = new Set([
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  // Someone killed this credential on purpose. Retrying re-presents the
  // same dead token; the application's backend has to mint a new one.
  'TOKEN_REVOKED',
  'UNAUTHORIZED',
  'ROOM_NOT_FOUND',
  'PERMISSION_DENIED',
  // Reconnecting cannot help: the page's origin is not on the project's
  // allow-list, and that is changed in the dashboard, not by retrying.
  'ORIGIN_NOT_ALLOWED',
  // Not a credential problem, but just as terminal, and it belongs here
  // for the reconnect behaviour rather than the reason. The account is out
  // of included minutes: unlike RATE_LIMITED there is no window to wait
  // out, so backing off and retrying would spin against a wall until the
  // attempt budget ran out. A fresh token would not help either — the
  // limit is on the account, not the token.
  'USAGE_LIMIT_EXCEEDED',
]);
