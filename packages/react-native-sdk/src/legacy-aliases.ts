// Deprecated Raven* names, kept so code written against the pre-rename
// package keeps compiling: change the import path, nothing else. Each is
// the very same value as its Swalvo* replacement (`instanceof` included).
import { Swalvo } from './swalvo';
import type { SwalvoAppState, SwalvoChatHandle, SwalvoConfig } from './types';
import { SwalvoLiveStream, type SwalvoLiveStreamOptions } from './live-stream';
import { SwalvoVideoView, type SwalvoVideoViewProps } from './video-view';
import type { SwalvoAudioOutput } from './audio';
import { useSwalvoError } from './hooks';
import {
  SwalvoPermissionError,
  isSwalvoPermissionError,
  type SwalvoPermissionKind,
  type SwalvoPermissionStatus,
} from './errors';
import { bootstrapSwalvoNative } from './internal/bootstrap';

/** @deprecated Renamed to {@link Swalvo}. */
export const Raven = Swalvo;
/** @deprecated Renamed to {@link Swalvo}. */
export type Raven = Swalvo;
/** @deprecated Renamed to {@link SwalvoConfig}. */
export type RavenConfig = SwalvoConfig;
/** @deprecated Renamed to {@link SwalvoChatHandle}. */
export type RavenChatHandle = SwalvoChatHandle;
/** @deprecated Renamed to {@link SwalvoAppState}. */
export type RavenAppState = SwalvoAppState;

/** @deprecated Renamed to {@link SwalvoLiveStream}. */
export const RavenLiveStream = SwalvoLiveStream;
/** @deprecated Renamed to {@link SwalvoLiveStream}. */
export type RavenLiveStream = SwalvoLiveStream;
/** @deprecated Renamed to {@link SwalvoLiveStreamOptions}. */
export type RavenLiveStreamOptions = SwalvoLiveStreamOptions;

/** @deprecated Renamed to {@link SwalvoVideoView}. */
export const RavenVideoView = SwalvoVideoView;
/** @deprecated Renamed to {@link SwalvoVideoViewProps}. */
export type RavenVideoViewProps = SwalvoVideoViewProps;

/** @deprecated Renamed to {@link SwalvoAudioOutput}. */
export type RavenAudioOutput = SwalvoAudioOutput;

/** @deprecated Renamed to {@link useSwalvoError}. */
export const useRavenError = useSwalvoError;

/** @deprecated Renamed to {@link SwalvoPermissionError}. */
export const RavenPermissionError = SwalvoPermissionError;
/** @deprecated Renamed to {@link SwalvoPermissionError}. */
export type RavenPermissionError = SwalvoPermissionError;
/** @deprecated Renamed to {@link isSwalvoPermissionError}. */
export const isRavenPermissionError = isSwalvoPermissionError;
/** @deprecated Renamed to {@link SwalvoPermissionKind}. */
export type RavenPermissionKind = SwalvoPermissionKind;
/** @deprecated Renamed to {@link SwalvoPermissionStatus}. */
export type RavenPermissionStatus = SwalvoPermissionStatus;

/** @deprecated Renamed to {@link bootstrapSwalvoNative}. */
export const bootstrapRavenNative = bootstrapSwalvoNative;
