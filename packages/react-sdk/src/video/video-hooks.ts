'use client';

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import type {
  DeviceInfo,
  DeviceKind,
  DisconnectReason,
  LocalTrack,
  Participant,
  RTCError,
  Room,
  Track,
} from '@swalvo/rtc';
import { SwalvoStoreContext } from '../context';
import { useOptionalRoom } from '../hooks';
import type { SwalvoConnectionState } from '../store';
import { audioPlaybackFor, devicePreferencesFor } from './stores';
import type { TrackReference, TrackSource, TrackSourceWithOptions } from './types';

// ---------------------------------------------------------------------------
// The video UI kit's hooks. Every one of them works without the components,
// so a fully custom call screen can be built from these plus SwalvoVideo.
//
// Room-scoped hooks read the room from <SwalvoRoom> when there is one and
// accept `{ room }` otherwise. None throws outside a provider; they report
// an empty or idle state instead, which is what lets <PreJoin> and a
// standalone <MediaDeviceMenu> render before any room exists.
// ---------------------------------------------------------------------------

type Listenable = {
  on?: (event: string, handler: (...args: never[]) => void) => unknown;
  off?: (event: string, handler: (...args: never[]) => void) => unknown;
};

/**
 * @internal A counter that increments whenever `target` emits one of
 * `events`. Components read SDK getters during render and use this to know
 * when to render again: the SDK's objects are mutable, so there is nothing
 * immutable to select from.
 */
export function useEventVersion(target: unknown, events: readonly string[]): number {
  const [version, setVersion] = useState(0);
  const key = events.join(',');
  useEffect(() => {
    const emitter = target as Listenable | undefined;
    if (!emitter || typeof emitter.on !== 'function') return undefined;
    const bump = () => setVersion((v) => v + 1);
    const names = key.split(',');
    for (const name of names) emitter.on(name, bump);
    return () => {
      for (const name of names) emitter.off?.(name, bump);
    };
  }, [target, key]);
  return version;
}

const ROSTER_EVENTS = [
  'participantJoined',
  'participantLeft',
  'trackSubscribed',
  'trackUnsubscribed',
  'trackMuted',
  'trackUnmuted',
  'trackPublished',
  'trackUnpublished',
  'localTrackPublished',
  'localTrackUnpublished',
  'localTrackMutedByServer',
  'connectionStateChanged',
] as const;

const MUTE_EVENTS = [
  'trackMuted',
  'trackUnmuted',
  'trackSubscribed',
  'trackUnsubscribed',
  'localTrackPublished',
  'localTrackUnpublished',
  'localTrackMutedByServer',
] as const;

const EMPTY_REFS: TrackReference[] = [];

export interface UseTracksOptions {
  /**
   * Leave out tracks a remote participant has published but you are not
   * subscribed to. Placeholders asked for with `withPlaceholder` are kept
   * either way. Default false.
   */
  onlySubscribed?: boolean;
  /** Use this room instead of the one from `<SwalvoRoom>`. */
  room?: Room;
}

const DEFAULT_SOURCES: TrackSourceWithOptions[] = [
  { source: 'camera', withPlaceholder: true },
  { source: 'screenShare', withPlaceholder: false },
];

/**
 * Every track of the given sources in the room, local participant first,
 * as `TrackReference`s ready to hand to `<ParticipantTile>` or a layout.
 *
 * The default (camera with placeholders, plus screen shares) is exactly
 * what a conference grid wants: everyone gets a tile, camera on or not.
 *
 * ```tsx
 * const tracks = useTracks([{ source: 'camera', withPlaceholder: true }, 'screenShare']);
 * ```
 *
 * The returned array, and each reference in it, keep their identity until
 * something about them actually changes, so they are safe to memoize on.
 */
export function useTracks(
  sources: ReadonlyArray<TrackSource | TrackSourceWithOptions> = DEFAULT_SOURCES,
  options: UseTracksOptions = {},
): TrackReference[] {
  const contextRoom = useOptionalRoom();
  const room = options.room ?? contextRoom;
  const onlySubscribed = options.onlySubscribed ?? false;
  const version = useEventVersion(room, ROSTER_EVENTS);

  // Remote sources announced with trackPublished but not (yet) subscribed:
  // the SDK lists only subscribed tracks on a participant.
  const published = useRef(new Map<Participant, Set<string>>());
  useEffect(() => {
    published.current = new Map();
    const emitter = room as unknown as Listenable | undefined;
    if (!emitter || typeof emitter.on !== 'function') return undefined;
    const onPublished = (kind: string, participant: Participant) => {
      const set = published.current.get(participant) ?? new Set<string>();
      set.add(kind);
      published.current.set(participant, set);
    };
    const onUnpublished = (kind: string, participant: Participant) => {
      published.current.get(participant)?.delete(kind);
    };
    const onLeft = (participant: Participant) => {
      published.current.delete(participant);
    };
    emitter.on('trackPublished', onPublished as never);
    emitter.on('trackUnpublished', onUnpublished as never);
    emitter.on('participantLeft', onLeft as never);
    return () => {
      emitter.off?.('trackPublished', onPublished as never);
      emitter.off?.('trackUnpublished', onUnpublished as never);
      emitter.off?.('participantLeft', onLeft as never);
    };
  }, [room]);

  const normalized = sources.map((s) =>
    typeof s === 'string'
      ? { source: s, withPlaceholder: false }
      : { source: s.source, withPlaceholder: !!s.withPlaceholder },
  );
  const sourcesKey = normalized.map((s) => `${s.source}:${s.withPlaceholder ? 1 : 0}`).join('|');

  const previous = useRef<TrackReference[]>(EMPTY_REFS);
  const refs = useMemo(() => {
    if (!room) return EMPTY_REFS;
    const wanted = sourcesKey
      .split('|')
      .filter(Boolean)
      .map((entry) => {
        const [source, placeholder] = entry.split(':');
        return { source: source as TrackSource, withPlaceholder: placeholder === '1' };
      });
    const local = room.localParticipant as Participant | undefined;
    const participants: Participant[] = [
      ...(local ? [local] : []),
      ...((room.remoteParticipants ?? []) as Participant[]),
    ];
    const next: TrackReference[] = [];
    for (const participant of participants) {
      const isLocal = participant === local;
      const tracks = ((participant as { tracks?: Track[] }).tracks ?? []) as Track[];
      for (const { source, withPlaceholder } of wanted) {
        const track = tracks.find((t) => t.kind === source);
        if (track) {
          next.push({ participant, source, track, isLocal });
        } else if (
          withPlaceholder ||
          (!onlySubscribed && !isLocal && published.current.get(participant)?.has(source))
        ) {
          next.push({ participant, source, track: undefined, isLocal });
        }
      }
    }
    return stabilize(previous.current, next);
    // `version` is the dependency that matters: the room mutates in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, version, sourcesKey, onlySubscribed]);
  previous.current = refs;
  return refs;
}

/** Reuses the previous references (and the previous array) where nothing changed. */
function stabilize(previous: TrackReference[], next: TrackReference[]): TrackReference[] {
  let same = previous.length === next.length;
  const out = next.map((ref, index) => {
    const match = previous.find(
      (old) =>
        old.participant === ref.participant &&
        old.source === ref.source &&
        old.track === ref.track &&
        old.isLocal === ref.isLocal,
    );
    if (!match || previous[index] !== match) same = false;
    return match ?? ref;
  });
  return same ? previous : out;
}

/**
 * Whether a reference's track is off: absent (a placeholder) or muted.
 * Re-renders on mute changes.
 */
export function useIsMuted(ref: Pick<TrackReference, 'track'> | undefined, room?: Room): boolean {
  const contextRoom = useOptionalRoom();
  useEventVersion(room ?? contextRoom, MUTE_EVENTS);
  return !ref?.track || ref.track.isMuted === true;
}

/** A participant's track of one source, kept current. */
export function useParticipantTrack(
  participant: Participant | undefined,
  source: TrackSource,
  room?: Room,
): Track | undefined {
  const contextRoom = useOptionalRoom();
  useEventVersion(room ?? contextRoom, ROSTER_EVENTS);
  const tracks = ((participant as { tracks?: Track[] } | undefined)?.tracks ?? []) as Track[];
  return tracks.find((t) => t.kind === source);
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export interface RoomConnectionInfo {
  /** `'idle'` before `join()` and outside `<SwalvoRoom>`. */
  state: SwalvoConnectionState;
  /** How many times the connection has dropped and started recovering. */
  reconnectCount: number;
  /** Why the room last disconnected, once it has. Cleared on (re)connect. */
  disconnectReason?: DisconnectReason;
}

const noopSubscribe = () => () => {};

/**
 * The room's connection state plus why it last disconnected — what a
 * "Reconnecting…" banner or a "You were removed" screen needs. Unlike
 * `useConnectionState()` it never throws outside `<SwalvoRoom>`.
 */
export function useRoomConnectionState(): RoomConnectionInfo {
  const store = useContext(SwalvoStoreContext);
  const subscribe = store ? store.subscribe : noopSubscribe;
  const state = useSyncExternalStore(
    subscribe,
    () => store?.getSnapshot().connectionState ?? 'idle',
    () => 'idle' as SwalvoConnectionState,
  );
  const reconnectCount = useSyncExternalStore(
    subscribe,
    () => store?.getSnapshot().reconnectCount ?? 0,
    () => 0,
  );
  const room = useOptionalRoom();
  const [disconnectReason, setDisconnectReason] = useState<DisconnectReason>();

  useEffect(() => {
    const emitter = room as unknown as Listenable | undefined;
    if (!emitter || typeof emitter.on !== 'function') return undefined;
    const onDisconnected = (reason?: DisconnectReason) => setDisconnectReason(reason ?? 'CONNECTION_FAILED');
    const onConnected = () => setDisconnectReason(undefined);
    emitter.on('disconnected', onDisconnected as never);
    emitter.on('connected', onConnected);
    emitter.on('reconnected', onConnected);
    return () => {
      emitter.off?.('disconnected', onDisconnected as never);
      emitter.off?.('connected', onConnected);
      emitter.off?.('reconnected', onConnected);
    };
  }, [room]);

  return useMemo(() => ({ state, reconnectCount, disconnectReason }), [state, reconnectCount, disconnectReason]);
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

const DEVICE_FALLBACK_LABEL: Record<DeviceKind, string> = {
  videoinput: 'Camera',
  audioinput: 'Microphone',
  audiooutput: 'Speaker',
};

function mediaDevices(): MediaDevices | undefined {
  return typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
}

/** Whether this browser can pick an audio output device (`setSinkId`). Safari cannot. */
export function supportsAudioOutputSelection(): boolean {
  if (typeof HTMLMediaElement === 'undefined') return false;
  return typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';
}

/** Whether this browser can share a screen (desktop browsers; not iOS or most Android). */
export function supportsScreenShare(): boolean {
  return typeof mediaDevices()?.getDisplayMedia === 'function';
}

/** @internal The device list plus a manual refresh; `useMediaDevices()` is the public face. */
export function useDeviceList(kind: DeviceKind): { devices: DeviceInfo[]; refresh: () => Promise<void> } {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const md = mediaDevices();
    if (!md?.enumerateDevices) return;
    try {
      const all = await md.enumerateDevices();
      const list = all
        .filter((d) => d.kind === kind && d.deviceId)
        .map((d, index) => ({
          deviceId: d.deviceId,
          label: d.label || `${DEVICE_FALLBACK_LABEL[kind]} ${index + 1}`,
          kind,
        }));
      if (!mounted.current) return;
      setDevices((prev) =>
        prev.length === list.length &&
        prev.every((p, i) => p.deviceId === list[i].deviceId && p.label === list[i].label)
          ? prev
          : list,
      );
    } catch {
      // enumerateDevices only rejects in insecure contexts; an empty list says as much.
    }
  }, [kind]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const md = mediaDevices();
    if (!md?.addEventListener) {
      return () => {
        mounted.current = false;
      };
    }
    const onChange = () => void refresh();
    md.addEventListener('devicechange', onChange);
    return () => {
      mounted.current = false;
      md.removeEventListener('devicechange', onChange);
    };
  }, [refresh]);

  return { devices, refresh };
}

/**
 * The devices of one kind (`'videoinput'`, `'audioinput'`,
 * `'audiooutput'`), kept current as they are plugged in and out. Labels
 * are only filled in once the user has granted a permission; until then
 * you get "Camera 1", "Camera 2". Works outside a room.
 */
export function useMediaDevices(kind: DeviceKind): DeviceInfo[] {
  return useDeviceList(kind).devices;
}

export interface UseMediaDeviceSelectOptions {
  kind: DeviceKind;
  room?: Room;
  onError?: (error: Error) => void;
}

export interface UseMediaDeviceSelectResult {
  devices: DeviceInfo[];
  /** The device in use, or the one picked to use next time this kind is enabled. `''` when unknown. */
  activeDeviceId: string;
  setActiveMediaDevice(deviceId: string): Promise<void>;
  /** Re-reads the device list, e.g. right after a permission grant. */
  refresh(): Promise<void>;
  pending: boolean;
  error?: Error;
}

const TRACK_FOR_DEVICE: Partial<Record<DeviceKind, TrackSource>> = {
  videoinput: 'camera',
  audioinput: 'microphone',
};

/**
 * A device list plus the active device, and a setter that switches the
 * live track without republishing (`room.setCameraDevice()` and friends).
 *
 * A device picked while that track is off is remembered and applied when
 * `useTrackToggle()` (or `<TrackToggle>`) next turns it on — the SDK on
 * its own only switches a device behind a track that is already live.
 */
export function useMediaDeviceSelect({
  kind,
  room: explicitRoom,
  onError,
}: UseMediaDeviceSelectOptions): UseMediaDeviceSelectResult {
  const contextRoom = useOptionalRoom();
  const room = explicitRoom ?? contextRoom;
  const { devices, refresh } = useDeviceList(kind);
  const prefs = devicePreferencesFor(room);
  const preferred = useSyncExternalStore(
    prefs.subscribe,
    () => prefs.get(kind),
    () => undefined,
  );
  const version = useEventVersion(room, ['localTrackPublished', 'localTrackUnpublished']);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();

  // A grant that came with publishing fills in device labels.
  useEffect(() => {
    if (version > 0) void refresh();
  }, [version, refresh]);

  const source = TRACK_FOR_DEVICE[kind];
  const track = source ? room?.localParticipant?.tracks?.find((t) => t.kind === source) : undefined;
  let trackDeviceId: string | undefined;
  try {
    trackDeviceId = track?.mediaStreamTrack?.getSettings?.().deviceId;
  } catch {
    trackDeviceId = undefined;
  }
  const activeDeviceId = preferred ?? trackDeviceId ?? '';

  const setActiveMediaDevice = useCallback(
    async (deviceId: string) => {
      setPending(true);
      setError(undefined);
      prefs.set(kind, deviceId);
      try {
        if (room) {
          if (kind === 'videoinput') await room.setCameraDevice(deviceId);
          else if (kind === 'audioinput') await room.setMicrophoneDevice(deviceId);
          else await room.setSpeakerDevice(deviceId);
        }
      } catch (err) {
        const e = err as Error;
        setError(e);
        onError?.(e);
      } finally {
        setPending(false);
      }
    },
    [room, kind, prefs, onError],
  );

  return { devices, activeDeviceId, setActiveMediaDevice, refresh, pending, error };
}

// ---------------------------------------------------------------------------
// Track toggles
// ---------------------------------------------------------------------------

export type ToggleSource = 'camera' | 'microphone' | 'screenShare';

export interface UseTrackToggleOptions {
  room?: Room;
  onChange?: (enabled: boolean) => void;
  onError?: (error: RTCError | Error) => void;
}

export interface UseTrackToggleResult {
  /** Published and not muted. */
  enabled: boolean;
  /** A toggle is in flight (permission prompt, capture, publish). */
  pending: boolean;
  /** The last toggle's failure, e.g. `CAMERA_PERMISSION_DENIED`. Cleared by the next attempt. */
  error?: RTCError | Error;
  track?: LocalTrack;
  /** Flips the state, or forces it with `toggle(true)` / `toggle(false)`. */
  toggle(force?: boolean): Promise<void>;
}

/**
 * On/off control for your camera, microphone or screen share, with the
 * pending and error states a button needs. Turning the camera or mic on
 * applies the device picked in `useMediaDeviceSelect()`. A microphone the
 * server muted (moderation) is unmuted rather than republished.
 */
export function useTrackToggle(source: ToggleSource, options: UseTrackToggleOptions = {}): UseTrackToggleResult {
  const contextRoom = useOptionalRoom();
  const room = options.room ?? contextRoom;
  useEventVersion(room, ['localTrackPublished', 'localTrackUnpublished', 'localTrackMutedByServer']);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<RTCError | Error>();
  const inFlight = useRef(false);
  const { onChange, onError } = options;

  const track = room?.localParticipant?.tracks?.find((t) => t.kind === source) as LocalTrack | undefined;
  const enabled = !!track && !track.isMuted;

  const toggle = useCallback(
    async (force?: boolean) => {
      if (!room || inFlight.current) return;
      const current = room.localParticipant?.tracks?.find((t) => t.kind === source) as LocalTrack | undefined;
      const isOn = !!current && !current.isMuted;
      const next = force ?? !isOn;
      if (next === isOn) return;
      inFlight.current = true;
      setPending(true);
      setError(undefined);
      try {
        if (next) {
          if (current && current.isMuted) {
            await current.unmute();
          } else if (source === 'camera') {
            await room.enableCamera();
            const preferred = devicePreferencesFor(room).get('videoinput');
            if (preferred) await room.setCameraDevice(preferred);
          } else if (source === 'microphone') {
            await room.enableMicrophone();
            const preferred = devicePreferencesFor(room).get('audioinput');
            if (preferred) await room.setMicrophoneDevice(preferred);
          } else {
            await room.enableScreenShare();
          }
        } else if (source === 'camera') {
          await room.disableCamera();
        } else if (source === 'microphone') {
          await room.disableMicrophone();
        } else {
          await room.disableScreenShare();
        }
        onChange?.(next);
      } catch (err) {
        const e = err as RTCError | Error;
        setError(e);
        onError?.(e);
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [room, source, onChange, onError],
  );

  return { enabled, pending, error, track, toggle };
}

export interface UseScreenShareResult extends UseTrackToggleResult {
  /** Whether this browser can share a screen at all. */
  supported: boolean;
  /** Every screen share in the room with a track, yours included. */
  screenShares: TrackReference[];
  /** Screen shares from other people. */
  remoteScreenShares: TrackReference[];
}

/** `useTrackToggle('screenShare')` plus who else is sharing. */
export function useScreenShare(options: UseTrackToggleOptions = {}): UseScreenShareResult {
  const toggle = useTrackToggle('screenShare', options);
  const shares = useTracks(SCREEN_SHARE_SOURCES, { room: options.room, onlySubscribed: true });
  const screenShares = useMemo(() => shares.filter((ref) => ref.track), [shares]);
  const remoteScreenShares = useMemo(() => screenShares.filter((ref) => !ref.isLocal), [screenShares]);
  return { ...toggle, supported: supportsScreenShare(), screenShares, remoteScreenShares };
}

const SCREEN_SHARE_SOURCES: TrackSource[] = ['screenShare'];

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

export interface UseDisconnectButtonResult {
  leave(): Promise<void>;
  pending: boolean;
  buttonProps: {
    type: 'button';
    onClick: () => void;
    'aria-busy'?: boolean;
    'data-pending'?: boolean;
  };
}

/**
 * Leaves the room (through `<SwalvoRoom>`'s store when there is one, so
 * every hook sees `'disconnected'`), then calls `onLeave`.
 */
export function useDisconnectButton(options: { onLeave?: () => void; room?: Room } = {}): UseDisconnectButtonResult {
  const store = useContext(SwalvoStoreContext);
  const contextRoom = useOptionalRoom();
  const room = options.room ?? contextRoom;
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const { onLeave } = options;

  const leave = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      // Through the store whenever it owns this room, so every hook sees
      // 'disconnected'; a room handed in from elsewhere is left directly.
      if (store && (!options.room || store.getSnapshot().room === options.room)) await store.leave();
      else await room?.leave();
    } finally {
      inFlight.current = false;
      setPending(false);
      onLeave?.();
    }
  }, [store, room, onLeave, options.room]);

  return {
    leave,
    pending,
    buttonProps: {
      type: 'button',
      onClick: () => void leave().catch(() => undefined),
      'aria-busy': pending || undefined,
      'data-pending': pending || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/**
 * Whether the browser's autoplay policy is blocking remote audio, and a
 * `startAudio()` to call from a click to unblock it. Fed by
 * `<RoomAudioRenderer>`; `<StartAudio>` is the ready-made button.
 */
export function useAudioPlayback(room?: Room): { canPlayAudio: boolean; startAudio(): Promise<void> } {
  const contextRoom = useOptionalRoom();
  const playback = audioPlaybackFor(room ?? contextRoom);
  const blocked = useSyncExternalStore(
    playback.subscribe,
    () => playback.blocked,
    () => false,
  );
  const startAudio = useCallback(() => playback.start(), [playback]);
  return { canPlayAudio: !blocked, startAudio };
}

type AudioContextCtor = new () => AudioContext;

/**
 * The live input level of an audio track, 0–1, sampled about ten times a
 * second — for a "is my mic working?" meter. 0 without a track or without
 * Web Audio.
 */
export function useAudioLevel(mediaStreamTrack: MediaStreamTrack | undefined, intervalMs = 100): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    setLevel(0);
    if (!mediaStreamTrack || typeof window === 'undefined') return undefined;
    const Ctor = ((window as unknown as { AudioContext?: AudioContextCtor }).AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as
      AudioContextCtor | undefined;
    if (!Ctor || typeof MediaStream === 'undefined') return undefined;

    let context: AudioContext;
    let sourceNode: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      context = new Ctor();
      sourceNode = context.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      sourceNode.connect(analyser);
    } catch {
      return undefined;
    }
    const data = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const x = (data[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / data.length);
      const next = Math.round(Math.min(1, rms * 4) * 20) / 20;
      setLevel((prev) => (prev === next ? prev : next));
    }, intervalMs);

    return () => {
      clearInterval(timer);
      try {
        sourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
      void context.close?.().catch(() => undefined);
    };
  }, [mediaStreamTrack, intervalMs]);

  return level;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export interface UsePaginationResult<T> {
  /** Zero-based. */
  page: number;
  totalPages: number;
  pageItems: T[];
  hasNext: boolean;
  hasPrev: boolean;
  next(): void;
  prev(): void;
  setPage(page: number): void;
}

/** Splits `items` into pages of `itemsPerPage`, clamping the page as the list shrinks. */
export function usePagination<T>(items: readonly T[], itemsPerPage: number): UsePaginationResult<T> {
  const per = Math.max(1, Math.floor(itemsPerPage) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / per));
  const [rawPage, setRawPage] = useState(0);
  const page = Math.min(Math.max(0, rawPage), totalPages - 1);
  const pageItems = useMemo(() => items.slice(page * per, page * per + per), [items, page, per]);
  const setPage = useCallback((next: number) => setRawPage(Math.max(0, next)), []);
  return {
    page,
    totalPages,
    pageItems,
    hasNext: page < totalPages - 1,
    hasPrev: page > 0,
    next: () => setRawPage(Math.min(page + 1, totalPages - 1)),
    prev: () => setRawPage(Math.max(page - 1, 0)),
    setPage,
  };
}

/** Columns for `count` tiles: 1, 2, 2×2, 3×3, 4×4, then roughly square. */
export function gridColumns(count: number, narrow = false): number {
  if (count <= 1) return 1;
  if (narrow) return count <= 2 ? 1 : 2;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  if (count <= 16) return 4;
  return Math.ceil(Math.sqrt(count));
}

export interface GridLayoutInfo {
  /** Measured container width; 0 before the first measurement. */
  width: number;
  /** Tiles that fit one page at this width, unless overridden. */
  maxTilesPerPage: number;
  narrow: boolean;
}

/**
 * Measures a grid container (ResizeObserver) and picks how many tiles fit
 * on a page: 4 on a phone, 9 on a tablet or narrow window, 16 wider.
 */
export function useGridLayout(ref: RefObject<HTMLElement | null>, maxTilesPerPage?: number): GridLayoutInfo {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  const narrow = width > 0 && width < 560;
  const auto = width === 0 ? 9 : narrow ? 4 : width < 1000 ? 9 : 16;
  return { width, maxTilesPerPage: maxTilesPerPage ?? auto, narrow };
}
