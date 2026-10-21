// Deprecated Raven* names, kept so code written against the pre-rename
// package keeps compiling: change the import path, nothing else. Each is
// the very same value as its Swalvo* replacement.
import { SwalvoRoom, type SwalvoRoomProps } from './swalvo-room';
import { useSwalvo, useSwalvoClient, useSwalvoError, type UseSwalvoResult } from './hooks';
import { SwalvoAudio, SwalvoVideo, type SwalvoAudioProps, type SwalvoVideoProps } from './components';
import type { SwalvoConnectionState, SwalvoSnapshot } from './store';
import { SwalvoLiveStream, type SwalvoLiveStreamProps } from './live/swalvo-live-stream';
import type { SwalvoLiveStreamContextValue, SwalvoLiveStreamStatus } from './live/live-context';

/** @deprecated Renamed to {@link SwalvoRoom}. */
export const RavenRoom = SwalvoRoom;
/** @deprecated Renamed to {@link SwalvoRoomProps}. */
export type RavenRoomProps = SwalvoRoomProps;

/** @deprecated Renamed to {@link useSwalvo}. */
export const useRaven = useSwalvo;
/** @deprecated Renamed to {@link useSwalvoClient}. */
export const useRavenClient = useSwalvoClient;
/** @deprecated Renamed to {@link useSwalvoError}. */
export const useRavenError = useSwalvoError;
/** @deprecated Renamed to {@link UseSwalvoResult}. */
export type UseRavenResult = UseSwalvoResult;

/** @deprecated Renamed to {@link SwalvoVideo}. */
export const RavenVideo = SwalvoVideo;
/** @deprecated Renamed to {@link SwalvoVideoProps}. */
export type RavenVideoProps = SwalvoVideoProps;
/** @deprecated Renamed to {@link SwalvoAudio}. */
export const RavenAudio = SwalvoAudio;
/** @deprecated Renamed to {@link SwalvoAudioProps}. */
export type RavenAudioProps = SwalvoAudioProps;

/** @deprecated Renamed to {@link SwalvoConnectionState}. */
export type RavenConnectionState = SwalvoConnectionState;
/** @deprecated Renamed to {@link SwalvoSnapshot}. */
export type RavenSnapshot = SwalvoSnapshot;

/** @deprecated Renamed to {@link SwalvoLiveStream}. */
export const RavenLiveStream = SwalvoLiveStream;
/** @deprecated Renamed to {@link SwalvoLiveStreamProps}. */
export type RavenLiveStreamProps = SwalvoLiveStreamProps;
/** @deprecated Renamed to {@link SwalvoLiveStreamContextValue}. */
export type RavenLiveStreamContextValue = SwalvoLiveStreamContextValue;
/** @deprecated Renamed to {@link SwalvoLiveStreamStatus}. */
export type RavenLiveStreamStatus = SwalvoLiveStreamStatus;

export * from './chat/legacy-aliases';
