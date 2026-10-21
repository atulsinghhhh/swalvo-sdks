/**
 * A hand-rolled fake of @swalvo/rtc's public surface. Same idea as the way
 * packages/sdk's own tests fake `RTCPeerConnection`, one layer further up.
 *
 * Every @swalvo/react test mocks the whole `@swalvo/rtc` module with
 * this file, via
 * `jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'))`,
 * so store, hook and component logic can be tested with no real WebRTC
 * stack anywhere in sight.
 */

type Handler = (...args: unknown[]) => void;

export class FakeEmitter {
  private listeners = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: string, handler: Handler): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  /** Test-only. Real @swalvo/rtc keeps emit() protected; this fake needs it public to drive scenarios. */
  emit(event: string, ...args: unknown[]): void {
    for (const handler of Array.from(this.listeners.get(event) ?? [])) handler(...args);
  }
}

export class FakeParticipant {
  tracks: unknown[] = [];
  constructor(public identity: string) {}
}

export class FakeRoom extends FakeEmitter {
  connectionState: string = 'connected';
  localParticipant = new FakeParticipant('local-user');
  remoteParticipants: FakeParticipant[] = [];
  activeSpeakers: unknown[] = [];

  enableCamera = jest.fn(async () => undefined);
  disableCamera = jest.fn(async () => undefined);
  enableMicrophone = jest.fn(async () => undefined);
  disableMicrophone = jest.fn(async () => undefined);
  enableScreenShare = jest.fn(async () => undefined);
  disableScreenShare = jest.fn(async () => undefined);
  setCameraDevice = jest.fn(async (_deviceId: string) => undefined);
  setMicrophoneDevice = jest.fn(async (_deviceId: string) => undefined);
  setSpeakerDevice = jest.fn(async (_deviceId: string) => undefined);
  leave = jest.fn(async () => undefined);

  constructor(public roomId: string) {
    super();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeClient {
  /**
   * `SwalvoRoom` calls `join()` synchronously inside its mount effect,
   * before a test has any chance to configure a mock return value.
   *
   * So `join()` always returns THIS specific, already-pending promise, and
   * a test resolves or rejects it directly through `pendingJoin.resolve(...)`
   * whenever it's ready. No racing against when the effect fires.
   */
  pendingJoin: Deferred<FakeRoom> = defer<FakeRoom>();
  joinMock = jest.fn((_roomId: string) => this.pendingJoin.promise);
  leaveMock = jest.fn(async () => undefined);

  constructor(public config: unknown) {
    instances.push(this);
  }

  join(roomId: string): Promise<FakeRoom> {
    return this.joinMock(roomId);
  }

  leave(): Promise<void> {
    return this.leaveMock();
  }
}

export const instances: FakeClient[] = [];

export function lastClient(): FakeClient {
  const client = instances[instances.length - 1];
  if (!client) throw new Error('No FakeClient was created yet; call createRTCClient() first');
  return client;
}

export function resetFakeRtc(): void {
  instances.length = 0;
}

export function createRTCClient(config: unknown): FakeClient {
  return new FakeClient(config);
}

export class RTCError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RTCError';
  }
}

/** The pre-call test. A test sets its behaviour with `runConnectionTest.mockImplementation(…)`. */
export const runConnectionTest = jest.fn(async (_options: unknown) => {
  throw new Error('runConnectionTest not mocked for this test');
});

export function isRTCError(value: unknown): value is RTCError {
  return value instanceof RTCError;
}

/**
 * Phase 6 captions. Not faked: it is a pure reducer with no WebRTC in it,
 * so the real one (from the built @swalvo/rtc) is the honest double.
 */
export const CaptionStore = (jest.requireActual('@swalvo/rtc') as typeof import('@swalvo/rtc')).CaptionStore;
