import {
  createRTCClient,
  type ConnectionState,
  type LocalParticipant,
  type RemoteParticipant,
  type Room,
  type RTCClient,
  type RTCClientConfig,
  type RTCError,
} from '@swalvo/rtc';

/** `'idle'` means `join()` hasn't been called yet. Not the same as `'disconnected'`, which means a real connection ended. */
export type SwalvoConnectionState = ConnectionState | 'idle';

export interface SwalvoSnapshot {
  connectionState: SwalvoConnectionState;
  client?: RTCClient;
  room?: Room;
  localParticipant?: LocalParticipant;
  remoteParticipants: RemoteParticipant[];
  error?: RTCError;
  reconnectCount: number;
}

const INITIAL_SNAPSHOT: SwalvoSnapshot = {
  connectionState: 'idle',
  remoteParticipants: [],
  reconnectCount: 0,
};

/**
 * Owns one `RTCClient`/`Room` pair and hands it out as an immutable
 * snapshot, the shape `useSyncExternalStore` wants (Phase 11 spec §30,
 * "avoid unnecessary rerenders").
 *
 * Every hook in this package reads an instance of this through context, and
 * each one selects only the slice it needs. So a change to, say,
 * `remoteParticipants` never re-renders a component that only reads
 * `connectionState`.
 *
 * The actual RTC logic all still lives in `@swalvo/rtc`. This class only
 * translates its event stream into React-friendly, referentially stable
 * snapshots. It never touches a peer connection, a track, or the signaling
 * socket.
 */
export class SwalvoStore {
  private snapshot: SwalvoSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private roomUnsubscribers: Array<() => void> = [];
  private client?: RTCClient;
  private disposed = false;

  getSnapshot = (): SwalvoSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private patch(partial: Partial<SwalvoSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener();
  }

  init(config: RTCClientConfig): void {
    this.client = createRTCClient(config);
    this.patch({ client: this.client });
  }

  async join(roomId: string): Promise<void> {
    if (!this.client) {
      throw new Error('SwalvoStore.init() must be called before join()');
    }
    this.patch({ connectionState: 'connecting', error: undefined });
    try {
      const room = await this.client.join(roomId);
      // `dispose()` can run while this join's network round trip is still in
      // flight — an ordinary "unmount during connect" race. `client.leave()`
      // inside `dispose()` is a no-op at that point (the client only records
      // `currentRoom` once `join()` resolves, see `RTCClient.join()`), so
      // without this check the room above would get wired into this store's
      // event machinery — 11 listeners nothing will ever remove — and stay
      // joined forever even though the caller already tore down.
      if (this.disposed) {
        void room.leave();
        return;
      }
      this.attachRoom(room);
    } catch (error) {
      this.patch({ connectionState: 'failed', error: error as RTCError });
      throw error;
    }
  }

  async leave(): Promise<void> {
    await this.client?.leave();
    this.detachRoom();
    this.patch({ ...INITIAL_SNAPSHOT, connectionState: 'disconnected', client: this.client });
  }

  /** Unsubscribes from room events and stops the underlying client. Call it on unmount. */
  dispose(): void {
    this.disposed = true;
    this.detachRoom();
    void this.client?.leave();
  }

  /**
   * Wires an already-joined `Room` into this store's reactive machinery
   * without calling `client.join()`.
   *
   * For a caller (Live Streaming) that got the room some other way and
   * still wants every existing hook working against it: `useParticipants`,
   * `useCamera`, and the rest.
   */
  attachExisting(room: Room, client?: RTCClient): void {
    if (client) {
      this.client = client;
      this.patch({ client });
    }
    this.attachRoom(room);
  }

  /**
   * `attachExisting()`'s counterpart to `dispose()`. Unsubscribes from room
   * events and never calls `client.leave()`.
   *
   * For a caller (Live Streaming) whose own `leave()` already tears the
   * room down. Do both and you leave it twice.
   */
  detachExisting(): void {
    this.detachRoom();
  }

  private attachRoom(room: Room): void {
    this.detachRoom();

    const onState = (state: ConnectionState) => this.patch({ connectionState: state });
    const onReconnecting = () => this.patch({ reconnectCount: this.snapshot.reconnectCount + 1 });
    const onError = (error: RTCError) => this.patch({ error });
    const onParticipantsChanged = () => this.syncParticipants(room);

    room.on('connectionStateChanged', onState);
    room.on('reconnecting', onReconnecting);
    room.on('error', onError);
    room.on('participantJoined', onParticipantsChanged);
    room.on('participantLeft', onParticipantsChanged);
    room.on('trackSubscribed', onParticipantsChanged);
    room.on('trackUnsubscribed', onParticipantsChanged);
    room.on('trackMuted', onParticipantsChanged);
    room.on('trackUnmuted', onParticipantsChanged);
    room.on('localTrackPublished', onParticipantsChanged);
    room.on('localTrackUnpublished', onParticipantsChanged);

    this.roomUnsubscribers = [
      () => room.off('connectionStateChanged', onState),
      () => room.off('reconnecting', onReconnecting),
      () => room.off('error', onError),
      () => room.off('participantJoined', onParticipantsChanged),
      () => room.off('participantLeft', onParticipantsChanged),
      () => room.off('trackSubscribed', onParticipantsChanged),
      () => room.off('trackUnsubscribed', onParticipantsChanged),
      () => room.off('trackMuted', onParticipantsChanged),
      () => room.off('trackUnmuted', onParticipantsChanged),
      () => room.off('localTrackPublished', onParticipantsChanged),
      () => room.off('localTrackUnpublished', onParticipantsChanged),
    ];

    this.patch({
      room,
      connectionState: room.connectionState,
      localParticipant: room.localParticipant,
      remoteParticipants: [...room.remoteParticipants],
    });
  }

  private syncParticipants(room: Room): void {
    // Fresh array and object references every time, on purpose. It's what
    // gives useSyncExternalStore something to Object.is against.
    this.patch({ remoteParticipants: [...room.remoteParticipants], localParticipant: room.localParticipant });
  }

  private detachRoom(): void {
    for (const unsubscribe of this.roomUnsubscribers) unsubscribe();
    this.roomUnsubscribers = [];
  }
}
