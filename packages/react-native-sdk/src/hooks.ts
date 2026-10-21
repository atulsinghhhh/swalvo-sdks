import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaptionStore } from '@swalvo/rtc';
import type {
  AgentState,
  CaptionSnapshot,
  ConnectionQuality,
  ConnectionState,
  ForwardedLayer,
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RTCError,
  TrackSubscriptionState,
} from '@swalvo/rtc';
import type { Swalvo } from './swalvo';
import type { SwalvoLiveStream } from './live-stream';

/**
 * Hooks for React Native.
 *
 * These mirror `@swalvo/react`'s hooks in name and in meaning, so the
 * same component code reads the same on both platforms. They are *not*
 * re-exported from that package. `@swalvo/react` is built around a
 * `<SwalvoRoom>` provider that owns the client and joins on mount, which
 * suits the web's one-page-one-call model. On mobile the `Swalvo` instance
 * usually outlives any single screen, held by a navigator or a store, so
 * these take the instance directly instead of fishing it out of context.
 *
 * Everything below is a subscription to events the SDK already emits.
 * Nothing here polls (spec §19).
 */

/** Live connection state for a room. `'disconnected'` when there is no room. */
export function useConnectionState(room: Room | undefined): ConnectionState {
  const [state, setState] = useState<ConnectionState>(room?.connectionState ?? 'disconnected');

  useEffect(() => {
    if (!room) {
      setState('disconnected');
      return undefined;
    }

    // Read once on attach as well as subscribing. The room may well have
    // connected before this component mounted, and waiting for the next
    // transition leaves the UI showing a stale state forever.
    setState(room.connectionState);

    const onChange = (next: ConnectionState) => setState(next);
    room.on('connectionStateChanged', onChange);
    // Block body, not a concise arrow. @swalvo/rtc's `off()` is chainable
    // and returns the room, which React would take for a cleanup function.
    return () => {
      room.off('connectionStateChanged', onChange);
    };
  }, [room]);

  return state;
}

/**
 * Everyone in the room, local participant first, then the remotes.
 *
 * Hands back a new array whenever the roster or anybody's tracks change,
 * which is what makes a `.map()` over it re-render properly.
 */
export function useParticipants(room: Room | undefined): (LocalParticipant | RemoteParticipant)[] {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!room) {
      return undefined;
    }

    const bump = () => setRevision((value) => value + 1);

    room.on('participantJoined', bump);
    room.on('participantLeft', bump);
    room.on('trackSubscribed', bump);
    room.on('trackUnsubscribed', bump);
    room.on('trackMuted', bump);
    room.on('trackUnmuted', bump);
    room.on('localTrackPublished', bump);
    room.on('localTrackUnpublished', bump);

    return () => {
      room.off('participantJoined', bump);
      room.off('participantLeft', bump);
      room.off('trackSubscribed', bump);
      room.off('trackUnsubscribed', bump);
      room.off('trackMuted', bump);
      room.off('trackUnmuted', bump);
      room.off('localTrackPublished', bump);
      room.off('localTrackUnpublished', bump);
    };
  }, [room]);

  return useMemo(() => {
    if (!room) return [];
    return [room.localParticipant, ...room.remoteParticipants];
    // Participants get mutated in place, so `revision` is what signals a
    // fresh array is needed. The objects themselves never will.
  }, [room, revision]);
}

export function useRemoteParticipants(room: Room | undefined): RemoteParticipant[] {
  const all = useParticipants(room);
  return useMemo(() => all.slice(1) as RemoteParticipant[], [all]);
}

export interface MediaToggle {
  enabled: boolean;
  /** True while the enable/disable call is in flight. Use it to disable the button. */
  busy: boolean;
  enable(): Promise<void>;
  disable(): Promise<void>;
  toggle(): Promise<void>;
  /** The last failure, most usefully a `SwalvoPermissionError`. */
  error?: RTCError;
}

/**
 * Camera on and off, with the state a button actually needs.
 *
 * `busy` matters far more on mobile than on web. Acquiring a camera takes
 * a noticeable moment on a phone, and without it someone double-taps and
 * toggles twice.
 */
export function useCamera(room: Room | undefined): MediaToggle {
  return useMediaToggle(room, 'camera');
}

export function useMicrophone(room: Room | undefined): MediaToggle {
  return useMediaToggle(room, 'microphone');
}

function useMediaToggle(room: Room | undefined, kind: 'camera' | 'microphone'): MediaToggle {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RTCError>();
  // Guards against a state update landing after unmount. React complains,
  // and it's easy to hit when someone leaves mid-toggle.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!room) {
      setEnabled(false);
      return undefined;
    }

    const sync = () => {
      const track = room.localParticipant.tracks.find((candidate) => candidate.kind === kind);
      setEnabled(Boolean(track) && !track?.isMuted);
    };

    sync();
    room.on('localTrackPublished', sync);
    room.on('localTrackUnpublished', sync);

    return () => {
      room.off('localTrackPublished', sync);
      room.off('localTrackUnpublished', sync);
    };
  }, [room, kind]);

  const run = useCallback(
    async (action: () => Promise<unknown>, next: boolean) => {
      if (!room) return;
      setBusy(true);
      setError(undefined);
      try {
        await action();
        if (mounted.current) setEnabled(next);
      } catch (err) {
        if (mounted.current) setError(err as RTCError);
        throw err;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [room],
  );

  const enable = useCallback(
    () => run(() => (kind === 'camera' ? room!.enableCamera() : room!.enableMicrophone()), true),
    [run, room, kind],
  );

  const disable = useCallback(
    () => run(() => (kind === 'camera' ? room!.disableCamera() : room!.disableMicrophone()), false),
    [run, room, kind],
  );

  const toggle = useCallback(() => (enabled ? disable() : enable()), [enabled, enable, disable]);

  return { enabled, busy, enable, disable, toggle, error };
}

/** The most recent error the room emitted, for a banner or a toast. */
export function useSwalvoError(room: Room | undefined): RTCError | undefined {
  const [error, setError] = useState<RTCError>();

  useEffect(() => {
    if (!room) {
      return undefined;
    }
    const onError = (next: RTCError) => setError(next);
    room.on('error', onError);
    return () => {
      room.off('error', onError);
    };
  }, [room]);

  return error;
}

// ---------------------------------------------------------------------------
// Phase 2 media signals (docs/architecture/phase2-media-contracts.md §2–§4).
// Same names and meanings as `@swalvo/react`; the room is passed in, as
// with every hook here. Each subscribes to the one event that can change its
// answer, so a long participant list does not re-render on every update.
// ---------------------------------------------------------------------------

/** Who is speaking right now, loudest first. Empty with no room, or when nobody is. */
export function useActiveSpeakers(room: Room | undefined): Participant[] {
  const [speakers, setSpeakers] = useState<Participant[]>(() => room?.activeSpeakers ?? []);

  useEffect(() => {
    setSpeakers(room?.activeSpeakers ?? []);
    if (!room) return undefined;
    const onChange = (next: Participant[]) => setSpeakers(next);
    room.on('activeSpeakersChanged', onChange);
    return () => {
      room.off('activeSpeakersChanged', onChange);
    };
  }, [room]);

  return speakers;
}

/** Whether `participant` is speaking. */
export function useIsSpeaking(participant: Participant | undefined): boolean {
  const [speaking, setSpeaking] = useState(() => participant?.isSpeaking === true);

  useEffect(() => {
    setSpeaking(participant?.isSpeaking === true);
    if (!participant || typeof participant.on !== 'function') return undefined;
    const onChange = (next: boolean) => setSpeaking(next);
    participant.on('isSpeakingChanged', onChange);
    return () => {
      participant.off('isSpeakingChanged', onChange);
    };
  }, [participant]);

  return speaking;
}

/** The SFU's connection-quality score for `participant`; pass `room.localParticipant` for your own. */
export function useConnectionQuality(participant: Participant | undefined): ConnectionQuality {
  const [quality, setQuality] = useState<ConnectionQuality>(() => participant?.connectionQuality ?? 'unknown');

  useEffect(() => {
    setQuality(participant?.connectionQuality ?? 'unknown');
    if (!participant || typeof participant.on !== 'function') return undefined;
    const onChange = (next: ConnectionQuality) => setQuality(next);
    participant.on('connectionQualityChanged', onChange);
    return () => {
      participant.off('connectionQualityChanged', onChange);
    };
  }, [participant]);

  return quality;
}

/**
 * `participant.metadata` and `participant.attributes`, live (phase 7).
 * Re-renders when the server confirms a change — your own
 * `setMetadata()` / `setAttributes()` included.
 */
export function useParticipantMetadata(participant: Participant | undefined): {
  metadata?: string;
  attributes: Record<string, string>;
} {
  const read = () => ({ metadata: participant?.metadata, attributes: participant?.attributes ?? {} });
  const [info, setInfo] = useState(read);

  useEffect(() => {
    setInfo(read());
    if (!participant || typeof participant.on !== 'function') return undefined;
    const onChange = () => setInfo(read());
    participant.on('metadataChanged', onChange);
    return () => {
      participant.off('metadataChanged', onChange);
    };
    // `read` closes over `participant` only, which is listed.
  }, [participant]);

  return info;
}

/**
 * Calls `handler` for every data message (phase 7), optionally only those
 * on one `topic`. `participant` is the sender, or `undefined` for a server
 * message. Subscribing opens the data channel(s) the room needs to receive.
 * The latest `handler` is always the one called, so an inline arrow is fine.
 */
export function useDataReceived(
  room: Room | undefined,
  handler: (payload: Uint8Array, participant: RemoteParticipant | undefined, topic: string | undefined) => void,
  options: { topic?: string } = {},
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const topic = options.topic;

  useEffect(() => {
    if (!room) return undefined;
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, received?: string) => {
      if (topic !== undefined && received !== topic) return;
      handlerRef.current(payload, participant, received);
    };
    room.on('dataReceived', onData);
    return () => {
      room.off('dataReceived', onData);
    };
  }, [room, topic]);
}

const NO_CAPTIONS: CaptionSnapshot = { segments: [], interim: {}, active: false };

/**
 * Live captions for `room` (phase 6, docs: /ai/transcription): the final
 * `segments` (oldest first, bounded by `maxSegments`, default 100), each
 * speaker's open `interim` segment by identity, and whether a
 * transcription is `active`. Same rules as `@swalvo/react`'s hook, from
 * the same `CaptionStore`: an interim is replaced by the next with its
 * `segmentId`, closed by the final, and cleared by an empty final.
 * Pass `participant` for one speaker only.
 */
export function useTranscription(
  room: Room | undefined,
  options: { participant?: Participant; maxSegments?: number } = {},
): CaptionSnapshot {
  const identity = options.participant?.identity;
  const maxSegments = options.maxSegments;
  const [snapshot, setSnapshot] = useState<CaptionSnapshot>(NO_CAPTIONS);

  useEffect(() => {
    setSnapshot(NO_CAPTIONS);
    if (!room || typeof room.on !== 'function') return undefined;
    const store = new CaptionStore({ participantId: identity, maxSegments });
    const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
    const detach = store.attach(room);
    return () => {
      detach();
      unsubscribe();
    };
  }, [room, identity, maxSegments]);

  return snapshot;
}

/**
 * An AI agent's state (phase 6, docs: /ai/agents): `'listening'`,
 * `'thinking'`, `'speaking'` or `'ended'`. `undefined` before the first
 * update and for anyone who is not an agent (`participant.isAgent`).
 */
export function useAgentState(participant: Participant | undefined): AgentState | undefined {
  const [state, setState] = useState<AgentState | undefined>(() => participant?.agentState);

  useEffect(() => {
    setState(participant?.agentState);
    if (!participant || typeof participant.on !== 'function') return undefined;
    const onChange = (next: AgentState) => setState(next);
    participant.on('agentStateChanged', onChange);
    return () => {
      participant.off('agentStateChanged', onChange);
    };
  }, [participant]);

  return state;
}

/** Whether the SFU is forwarding `track` to you, and at which layer. */
export function useTrackSubscriptionState(
  track: RemoteTrack | undefined,
  room: Room | undefined,
): { state: TrackSubscriptionState; layer?: ForwardedLayer } {
  const read = () => ({ state: track?.subscriptionState ?? ('active' as TrackSubscriptionState), layer: track?.layer });
  const [info, setInfo] = useState(read);

  useEffect(() => {
    setInfo(read());
    if (!room || !track) return undefined;
    const onChange = (changed: RemoteTrack) => {
      if (changed === track) setInfo(read());
    };
    room.on('trackSubscriptionStateChanged', onChange);
    return () => {
      room.off('trackSubscriptionStateChanged', onChange);
    };
    // `read` closes over `track` only, which is listed.
  }, [room, track]);

  return info;
}

/**
 * Joins on mount, leaves on unmount.
 *
 * The unmount cleanup is the whole point. On mobile a screen can vanish
 * because someone swiped back, and a call still running behind a dismissed
 * screen is both a bug and a battery drain (spec §19).
 */
export function useRoom(
  swalvo: Swalvo | undefined,
  roomId: string | undefined,
  options: { autoJoin?: boolean } = {},
): { room?: Room; joining: boolean; error?: RTCError } {
  const [room, setRoom] = useState<Room>();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<RTCError>();

  useEffect(() => {
    if (!swalvo || !roomId || options.autoJoin === false) {
      return undefined;
    }

    let cancelled = false;
    setJoining(true);
    setError(undefined);

    swalvo
      .join(roomId)
      .then((joined) => {
        // Screen went away while we were still connecting. Leave straight
        // away; anything else and the call outlives its own UI.
        if (cancelled) {
          void swalvo.leave();
          return;
        }
        setRoom(joined);
      })
      .catch((err) => {
        if (!cancelled) setError(err as RTCError);
      })
      .finally(() => {
        if (!cancelled) setJoining(false);
      });

    return () => {
      cancelled = true;
      setRoom(undefined);
      void swalvo.leave();
    };
  }, [swalvo, roomId, options.autoJoin]);

  return { room, joining, error };
}

/**
 * Joins a live stream on mount and leaves on unmount. The Live Streaming
 * counterpart to `useRoom()`.
 *
 * Returns the same `Room` that `useParticipants()`, `useCamera()`,
 * `useMicrophone()` and `useSwalvoError()` already take, so there's nothing
 * new to learn to use them against a stream.
 */
export function useLiveStream(
  stream: SwalvoLiveStream | undefined,
  options: { autoJoin?: boolean } = {},
): { room?: Room; joining: boolean; error?: RTCError } {
  const [room, setRoom] = useState<Room>();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<RTCError>();

  useEffect(() => {
    if (!stream || options.autoJoin === false) {
      return undefined;
    }

    let cancelled = false;
    setJoining(true);
    setError(undefined);

    stream
      .join()
      .then((joined) => {
        if (cancelled) {
          void stream.leave();
          return;
        }
        setRoom(joined);
      })
      .catch((err) => {
        if (!cancelled) setError(err as RTCError);
      })
      .finally(() => {
        if (!cancelled) setJoining(false);
      });

    return () => {
      cancelled = true;
      setRoom(undefined);
      void stream.leave();
    };
  }, [stream, options.autoJoin]);

  return { room, joining, error };
}
