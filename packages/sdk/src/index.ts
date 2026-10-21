export { createRTCClient, RTCClient } from './client';
export type { RTCClientConfig } from './config';

export { Room } from './room';
export type { ConnectionDiagnostics, ConnectionStats, ConnectionState, RoomEventMap } from './room';

export { Participant, LocalParticipant, RemoteParticipant } from './participant';
export type { ParticipantEventMap, ParticipantMetadataSnapshot } from './participant';

export { Track, LocalTrack, RemoteTrack, trackKindToMediaKind } from './track';
export { createCustomTrack } from './internal/media/capture';
export type { CustomTrackOptions, CustomTrackSource } from './internal/media/capture';
export type { TrackKind, TrackStats, MediaKind, TrackSubscriptionState, ForwardedLayer } from './track';
/** The simulcast layer names `RemoteTrack.setLayer()` accepts. */
export type { VideoLayer } from './internal/media/adaptive-stream';
/** What `Room.simulcastStatus()` reports about a published camera. */
export type { SimulcastStatus } from './internal/sfu/simulcast';
/**
 * The structural interfaces a `Track` wraps.
 *
 * Exported so a platform SDK, or an application with an unusual media
 * source, can build a Swalvo track over something the browser never handed
 * it. They used to be internal, which left guessing at the shape
 * as the only way to satisfy them.
 */
export type { TrackDelegate, LocalTrackDelegate, RemoteTrackDelegate } from './track';

/**
 * End-to-end encryption (docs: /rtc/e2ee). The key providers are the only
 * route to the transform worker, so an app that never calls them never
 * bundles it (`sideEffects: false`).
 */
export { createKeyProvider, createSharedKeyProvider, KeyProvider } from './e2ee/key-provider';
export type { KeyProviderOptions } from './e2ee/key-provider';
export { isE2EESupported } from './e2ee/support';
export type { E2EEOptions, E2EEState } from './e2ee/types';
export type { VideoCodec } from './config';

/** Live transcription captions and AI voice agents (docs: /ai/transcription, /ai/agents). */
export {
  CaptionStore,
  isAgentIdentity,
  isTranscriberIdentity,
  AGENT_IDENTITY_PREFIX,
  TRANSCRIBER_IDENTITY_PREFIX,
} from './transcription';
export type {
  AgentState,
  CaptionSnapshot,
  CaptionSource,
  CaptionStoreOptions,
  TranscriptionSegment,
  TranscriptionState,
  TranscriptionStatus,
} from './transcription';

export { RTCError, isRTCError } from './errors';
export type { RTCErrorCode } from './errors';

export type { LogLevel } from './logger';

export type {
  ConnectionQuality,
  DataChannelKind,
  DataSendOptions,
  ScreenShareOptions,
  DeviceInfo,
  DeviceKind,
  DisconnectReason,
  ParticipantPermissions,
  RTCWarning,
  RTCWarningCode,
} from './internal/sfu/types';

/**
 * The pre-call test. Its own module, imported by nothing else, so it
 * costs an application that never calls it nothing (`sideEffects: false`).
 */
export { runConnectionTest } from './preflight';
export type {
  CheckStatus,
  ConnectionRoute,
  ConnectionTestIssue,
  ConnectionTestOptions,
  ConnectionTestReport,
  ConnectionTestStage,
  DeviceCheck,
  NetworkSummary,
  StepCheck,
} from './preflight';

export { getBrowserSupportDetails, isBrowserSupported } from './browser-support';
export type { BrowserSupportDetails } from './browser-support';
