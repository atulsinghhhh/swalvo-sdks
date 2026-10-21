export { Swalvo } from './swalvo';
export type { SwalvoConfig, SwalvoChatHandle, SwalvoAppState } from './types';

// ---------------------------------------------------------------------------
// Live Streaming (Phase 14). A thin wrapper round `Swalvo`, not a parallel
// RTC/chat implementation. See src/live-stream.ts.
// ---------------------------------------------------------------------------
export { SwalvoLiveStream, joinLiveStream } from './live-stream';
export type { SwalvoLiveStreamOptions, LiveStageEvent } from './live-stream';
export { LiveStreamPlayer } from './live-stream-player';
export type { LiveStreamPlayerProps } from './live-stream-player';
export type { LiveStreamCredentials, LiveStreamRole } from './types';

export { SwalvoVideoView } from './video-view';
export type { SwalvoVideoViewProps } from './video-view';

export { runConnectionTest } from './preflight';
export type { ConnectionTestOptions, ConnectionTestReport, ConnectionTestIssue } from '@swalvo/rtc';

export { permissions } from './permissions';
export type { PermissionResult } from './permissions';

export { audio } from './audio';
export type { SwalvoAudioOutput } from './audio';

export {
  useActiveSpeakers,
  useCamera,
  useConnectionQuality,
  useConnectionState,
  useDataReceived,
  useIsSpeaking,
  useLiveStream,
  useMicrophone,
  useParticipantMetadata,
  useParticipants,
  useSwalvoError,
  useRemoteParticipants,
  useRoom,
  useTrackSubscriptionState,
  useTranscription,
  useAgentState,
} from './hooks';
export type { MediaToggle } from './hooks';

export { SwalvoPermissionError, RTCError, isSwalvoPermissionError, isRTCError } from './errors';
export type { SwalvoPermissionKind, SwalvoPermissionStatus, RTCErrorCode } from './errors';

/**
 * Only call this by hand if you need the WebRTC globals in place before a
 * `Swalvo` instance exists, say to render a camera preview on a pre-join
 * screen. Otherwise `new Swalvo(...)` handles it.
 */
export { bootstrapSwalvoNative } from './internal/bootstrap';

export { RN_SDK_VERSION } from './version';

/**
 * Re-exported from `@swalvo/rtc` so a mobile app needs one import for the
 * common types. These are the *same* types the web SDK uses: a `Room` here
 * is a `Room` there. That's what makes the two platforms one mental model
 * instead of two APIs that merely resemble each other (spec §10).
 *
 * A WebRTC type is never re-exported, on either platform.
 */
export type {
  ConnectionQuality,
  ConnectionState,
  DataChannelKind,
  DataSendOptions,
  ParticipantMetadataSnapshot,
  ScreenShareOptions,
  DeviceInfo,
  ForwardedLayer,
  TrackSubscriptionState,
  DeviceKind,
  LocalParticipant,
  LocalTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  Track,
  TrackKind,
  LogLevel,
  AgentState,
  CaptionSnapshot,
  TranscriptionSegment,
  TranscriptionState,
  TranscriptionStatus,
} from '@swalvo/rtc';
/** The caption reducer behind `useTranscription`, for a custom UI or a store outside React. */
export { CaptionStore, isAgentIdentity, isTranscriberIdentity } from '@swalvo/rtc';

// Pointedly not exported: the signaling client, the peer-connection
// adapter, `registerGlobals` internals, RTCView, the chat WebSocket
// protocol, and every other implementation detail. Nobody using this
// package should ever need to know a WebRTC or a WebSocket is involved
// (spec §2, §21).

// Deprecated Raven* aliases (renamed to Swalvo*).
export * from './legacy-aliases';
