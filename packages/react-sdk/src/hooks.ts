'use client';

import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CaptionStore } from '@swalvo/rtc';
import type {
  AgentState,
  CaptionSnapshot,
  ConnectionQuality,
  E2EEState,
  ForwardedLayer,
  LocalParticipant,
  LocalTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RTCError,
  Room,
  RTCClient,
  TrackSubscriptionState,
  TranscriptionSegment,
  TranscriptionState,
} from '@swalvo/rtc';
import { SwalvoStoreContext, useSwalvoStore } from './context';
import type { SwalvoConnectionState, SwalvoSnapshot } from './store';

/** The full snapshot plus `join` and `leave`. Use the narrower hooks below where you can, and avoid re-rendering on unrelated changes. */
export interface UseSwalvoResult extends SwalvoSnapshot {
  join(roomId: string): Promise<void>;
  leave(): Promise<void>;
}

export function useSwalvo(): UseSwalvoResult {
  const store = useSwalvoStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return useMemo(
    () => ({ ...snapshot, join: store.join.bind(store), leave: store.leave.bind(store) }),
    [snapshot, store],
  );
}

export function useRoom(): Room | undefined {
  const store = useSwalvoStore();
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().room);
}

/** @internal Exposed mostly so `examples/` and advanced integrations can reach the raw client before a room exists. */
export function useSwalvoClient(): RTCClient | undefined {
  const store = useSwalvoStore();
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().client);
}

export function useConnectionState(): SwalvoConnectionState {
  const store = useSwalvoStore();
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().connectionState);
}

export function useLocalParticipant() {
  const store = useSwalvoStore();
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().localParticipant);
}

export function useRemoteParticipants() {
  const store = useSwalvoStore();
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().remoteParticipants);
}

/** Local participant, if joined, then every remote one. The full roster in one call. */
export function useParticipants(): (LocalParticipant | RemoteParticipant)[] {
  const local = useLocalParticipant();
  const remote = useRemoteParticipants();
  return useMemo(() => (local ? [local, ...remote] : [...remote]), [local, remote]);
}

export function useSwalvoError(): RTCError | undefined {
  const store = useSwalvoStore();
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().error);
}

interface LocalMediaControl {
  enabled: boolean;
  track?: LocalTrack;
  enable(): Promise<void>;
  disable(): Promise<void>;
  error?: RTCError;
}

function useLocalMediaTrack(kind: 'camera' | 'microphone'): LocalMediaControl {
  const room = useRoom();
  const [track, setTrack] = useState<LocalTrack | undefined>(() =>
    room?.localParticipant.tracks.find((t) => t.kind === kind),
  );
  const [error, setError] = useState<RTCError>();

  useEffect(() => {
    if (!room) return undefined;
    const sync = () => setTrack(room.localParticipant.tracks.find((t) => t.kind === kind));
    sync();
    room.on('localTrackPublished', sync);
    room.on('localTrackUnpublished', sync);
    return () => {
      room.off('localTrackPublished', sync);
      room.off('localTrackUnpublished', sync);
    };
  }, [room, kind]);

  const enable = useCallback(async () => {
    if (!room) return;
    try {
      await (kind === 'camera' ? room.enableCamera() : room.enableMicrophone());
      setError(undefined);
    } catch (err) {
      setError(err as RTCError);
      throw err;
    }
  }, [room, kind]);

  const disable = useCallback(async () => {
    if (!room) return;
    await (kind === 'camera' ? room.disableCamera() : room.disableMicrophone());
  }, [room, kind]);

  return { enabled: Boolean(track), track, enable, disable, error };
}

export function useCamera(): LocalMediaControl {
  return useLocalMediaTrack('camera');
}

export function useMicrophone(): LocalMediaControl {
  return useLocalMediaTrack('microphone');
}

// ---------------------------------------------------------------------------
// Phase 2 media signals: active speakers, connection quality, subscription
// state (docs/architecture/phase2-media-contracts.md §2–§4).
//
// The participant- and track-level hooks read straight off the object they
// are given, so they work inside or outside <SwalvoRoom>. Each subscribes to
// exactly the one event that can change its answer, which is what keeps a
// 25-tile grid from re-rendering every tile on every speaker update.
// ---------------------------------------------------------------------------

/** The room from context when there is one; never throws outside `<SwalvoRoom>`. */
/** @internal Shared with the video UI kit; not part of the public barrel. */
export function useOptionalRoom(): Room | undefined {
  const store = useContext(SwalvoStoreContext);
  const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => {}), [store]);
  return useSyncExternalStore(subscribe, () => store?.getSnapshot().room);
}

type Listenable = {
  on?: (event: string, handler: (...args: never[]) => void) => unknown;
  off?: (event: string, handler: (...args: never[]) => void) => unknown;
};

/** Subscribes to one event on an SDK object, tolerating test doubles and older SDKs that lack `on`. */
function useEvent(target: Listenable | undefined, event: string, handler: () => void): void {
  useEffect(() => {
    if (!target || typeof target.on !== 'function') return undefined;
    target.on(event, handler);
    return () => {
      target.off?.(event, handler);
    };
  }, [target, event, handler]);
}

/**
 * Who is speaking right now, loudest first, as the SFU measures it. Empty
 * when nobody is, before joining, and against a server without speaker
 * detection. Re-renders only when the set of speakers changes.
 *
 * ```tsx
 * const [loudest] = useActiveSpeakers();
 * return loudest ? <Spotlight participant={loudest} /> : <Grid />;
 * ```
 */
export function useActiveSpeakers(): Participant[] {
  const room = useOptionalRoom();
  const [speakers, setSpeakers] = useState<Participant[]>(() => room?.activeSpeakers ?? []);
  const sync = useCallback(() => setSpeakers(room?.activeSpeakers ?? []), [room]);
  useEffect(sync, [sync]);
  useEvent(room as Listenable | undefined, 'activeSpeakersChanged', sync);
  return speakers;
}

/** Whether `participant` is speaking. False for `undefined`. */
export function useIsSpeaking(participant: Participant | undefined): boolean {
  const [speaking, setSpeaking] = useState(() => participant?.isSpeaking === true);
  const sync = useCallback(() => setSpeaking(participant?.isSpeaking === true), [participant]);
  useEffect(sync, [sync]);
  useEvent(participant as Listenable | undefined, 'isSpeakingChanged', sync);
  return speaking;
}

/**
 * The SFU's connection-quality score for `participant` — pass
 * `room.localParticipant` (or `useLocalParticipant()`) for your own.
 * `'unknown'` until scored, and for `undefined`.
 */
export function useConnectionQuality(participant: Participant | undefined): ConnectionQuality {
  const read = useCallback((): ConnectionQuality => participant?.connectionQuality ?? 'unknown', [participant]);
  const [quality, setQuality] = useState<ConnectionQuality>(read);
  const sync = useCallback(() => setQuality(read()), [read]);
  useEffect(sync, [sync]);
  useEvent(participant as Listenable | undefined, 'connectionQualityChanged', sync);
  return quality;
}

export interface TrackSubscriptionInfo {
  /** See `TrackSubscriptionState`. `'active'` for `undefined` and for an SDK that predates it. */
  state: TrackSubscriptionState;
  /** The layer the SFU says it is forwarding, when it has said. */
  layer?: ForwardedLayer;
}

/**
 * Whether the SFU is forwarding `track` to you, and at which layer. Show a
 * "paused — poor connection" overlay on `state === 'paused_bandwidth'`
 * instead of a frozen frame. Needs the room, so either render it inside
 * `<SwalvoRoom>` or pass the room explicitly.
 */
export function useTrackSubscriptionState(track: RemoteTrack | undefined, room?: Room): TrackSubscriptionInfo {
  const contextRoom = useOptionalRoom();
  const source = room ?? contextRoom;
  const read = useCallback(
    (): TrackSubscriptionInfo => ({ state: track?.subscriptionState ?? 'active', layer: track?.layer }),
    [track],
  );
  const [info, setInfo] = useState<TrackSubscriptionInfo>(read);
  const sync = useCallback(() => {
    setInfo((previous) => {
      const next = read();
      return previous.state === next.state && previous.layer === next.layer ? previous : next;
    });
  }, [read]);
  useEffect(sync, [sync]);
  const onChange = useCallback(
    (...args: unknown[]) => {
      if (args[0] === track) sync();
    },
    [track, sync],
  );
  useEvent(source as Listenable | undefined, 'trackSubscriptionStateChanged', onChange as () => void);
  return info;
}

/**
 * End-to-end encryption state for `participant` (docs: /rtc/e2ee):
 * `'ok'`, `'missing_key'`, `'decrypt_failed'` or `'encrypt_failed'`;
 * `undefined` until the SDK has reported one (and always outside an E2EE
 * room). For `room.localParticipant` it describes what you send; for a
 * remote participant, whether you can decrypt them. Show a "can't decrypt
 * — check the passphrase" badge on `'decrypt_failed'` / `'missing_key'`.
 */
export function useE2EEState(participant: Participant | undefined, room?: Room): E2EEState | undefined {
  const contextRoom = useOptionalRoom();
  const source = room ?? contextRoom;
  const [state, setState] = useState<E2EEState | undefined>(undefined);
  useEffect(() => setState(undefined), [participant]);
  const onChange = useCallback(
    (...args: unknown[]) => {
      if (participant && args[0] === participant) setState(args[1] as E2EEState);
    },
    [participant],
  );
  useEvent(source as Listenable | undefined, 'e2eeStateChanged', onChange as () => void);
  return state;
}

export interface UseTranscriptionOptions {
  /** Only this speaker's captions. */
  participant?: Participant;
  /** How many final segments to keep. Default 100. */
  maxSegments?: number;
  /** Defaults to the room from `<SwalvoRoom>`. */
  room?: Room;
}

export interface UseTranscriptionResult {
  /** Final segments, oldest first, bounded by `maxSegments`. */
  segments: readonly TranscriptionSegment[];
  /** Each speaker's open interim segment, by participant identity. */
  interim: Readonly<Record<string, TranscriptionSegment>>;
  /** Whether a transcription is running in the room. */
  active: boolean;
  /** The latest `transcription.state`, once one has arrived. */
  state?: TranscriptionState;
}

const EMPTY_CAPTIONS: CaptionSnapshot = { segments: [], interim: {}, active: false };
const noopUnsubscribe = () => () => {};

/**
 * Live captions for the room (docs: /ai/transcription): the final
 * segments, each speaker's interim line, and whether a transcription is
 * running. Interim text is replaced as it firms up and cleared when its
 * final arrives (or when the provider withdraws it with an empty final).
 * Captions start from when the hook mounts. Agent speech is included,
 * under the agent's identity.
 *
 * ```tsx
 * const { segments, interim, active } = useTranscription();
 * ```
 */
export function useTranscription(options: UseTranscriptionOptions = {}): UseTranscriptionResult {
  const contextRoom = useOptionalRoom();
  const room = options.room ?? contextRoom;
  const identity = options.participant?.identity;
  const { maxSegments } = options;
  const store = useMemo(
    () => (room ? new CaptionStore({ participantId: identity, maxSegments }) : undefined),
    [room, identity, maxSegments],
  );
  useEffect(() => {
    if (!room || !store || typeof (room as { on?: unknown }).on !== 'function') return undefined;
    return store.attach(room);
  }, [room, store]);
  const subscribe = store ? store.subscribe : noopUnsubscribe;
  const getSnapshot = store ? store.getSnapshot : () => EMPTY_CAPTIONS;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * An AI agent's state: `'listening'`, `'thinking'`, `'speaking'` or
 * `'ended'`; `undefined` before its first update and for anyone who is
 * not an agent (`participant.isAgent`).
 */
export function useAgentState(participant: Participant | undefined): AgentState | undefined {
  const read = useCallback(
    (): AgentState | undefined => (participant as { agentState?: AgentState } | undefined)?.agentState,
    [participant],
  );
  const [state, setState] = useState<AgentState | undefined>(read);
  const sync = useCallback(() => setState(read()), [read]);
  useEffect(sync, [sync]);
  useEvent(participant as Listenable | undefined, 'agentStateChanged', sync);
  return state;
}
