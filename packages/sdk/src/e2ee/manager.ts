import workerSource from './worker.ts?inline-worker';
import {
  payloadTypesFromSdp,
  type MainToWorkerMessage,
  type TransformOptions,
  type WorkerToMainMessage,
} from './worker-protocol';
import type { E2EEController, E2EEState } from './types';

import { hasScriptTransform } from './support';

declare const RTCRtpScriptTransform: {
  new (worker: Worker, options?: unknown, transfer?: Transferable[]): unknown;
};

type LegacyEncodedStreams = { readable: ReadableStream; writable: WritableStream };

/** The provider-side hooks a manager calls back into. */
export interface KeyProviderHost {
  readonly sharedKey: boolean;
  readonly ratchetWindow: number;
  /** Every key the provider currently holds, to replay into a fresh worker. */
  currentKeys(roomId: string): Promise<Array<{ participantId?: string; material: Uint8Array; keyIndex: number }>>;
  register(manager: E2EEManager): void;
  unregister(manager: E2EEManager): void;
  onWorkerRatcheted(participantId: string | undefined, keyIndex: number, material: Uint8Array): void;
}

let transformCounter = 0;

/**
 * Main-thread side of E2EE for one connection: owns the worker, hangs a
 * transform on every sender and receiver, and relays keys and states.
 */
export class E2EEManager implements E2EEController {
  readonly needsInsertableStreams = !hasScriptTransform();
  private readonly worker: Worker;
  private readonly ownsWorker: boolean;
  private readonly transformed = new WeakSet<RTCRtpSender | RTCRtpReceiver>();
  private readonly receiverIds = new WeakMap<RTCRtpReceiver, string>();
  private listener?: (participantId: string, direction: 'encrypt' | 'decrypt', state: E2EEState) => void;
  private pendingRatchets = new Map<number, (material: Uint8Array | undefined) => void>();
  private requestId = 0;
  private started = false;

  constructor(
    private readonly host: KeyProviderHost,
    options: { worker?: Worker; log?: (message: string) => void },
  ) {
    if (options.worker) {
      this.worker = options.worker;
      this.ownsWorker = false;
    } else {
      const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      this.worker = new Worker(url, { name: 'livqeno-e2ee' });
      URL.revokeObjectURL(url);
      this.ownsWorker = true;
    }
    this.worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => this.handleWorkerMessage(event.data);
    this.worker.onerror = (event) => options.log?.(`e2ee worker error: ${(event as ErrorEvent).message ?? event}`);
    host.register(this);
  }

  private post(message: MainToWorkerMessage, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private handleWorkerMessage(message: WorkerToMainMessage): void {
    switch (message.type) {
      case 'state':
        this.listener?.(message.participantId, message.direction, message.state);
        break;
      case 'ratcheted':
        if (message.requestId !== undefined) {
          this.pendingRatchets.get(message.requestId)?.(message.material);
          this.pendingRatchets.delete(message.requestId);
        } else {
          this.host.onWorkerRatcheted(message.participantId, message.keyIndex, message.material);
        }
        break;
      default:
        break;
    }
  }

  setStateListener(
    listener: (participantId: string, direction: 'encrypt' | 'decrypt', state: E2EEState) => void,
  ): void {
    this.listener = listener;
  }

  async start(roomId: string, localParticipantId: string, enabled: boolean): Promise<void> {
    this.post({
      type: 'init',
      sharedKey: this.host.sharedKey,
      ratchetWindow: this.host.ratchetWindow,
      localParticipantId,
      enabled,
    });
    if (!this.started) {
      this.started = true;
      for (const key of await this.host.currentKeys(roomId)) {
        this.pushKey(key.participantId, key.material, key.keyIndex);
      }
    }
  }

  /** Called by the provider whenever the app sets a key. */
  pushKey(participantId: string | undefined, material: Uint8Array, keyIndex: number): void {
    this.post({ type: 'setKey', participantId, material, keyIndex });
  }

  /** Ratchets inside the worker (where the live key ring is). */
  ratchet(participantId: string | undefined, keyIndex?: number): Promise<Uint8Array | undefined> {
    const requestId = ++this.requestId;
    return new Promise((resolve) => {
      this.pendingRatchets.set(requestId, resolve);
      this.post({ type: 'ratchet', requestId, participantId, keyIndex });
    });
  }

  private attach(target: RTCRtpSender | RTCRtpReceiver, options: TransformOptions): void {
    if (this.transformed.has(target)) return;
    this.transformed.add(target);
    if (hasScriptTransform()) {
      (target as unknown as { transform: unknown }).transform = new RTCRtpScriptTransform(this.worker, options);
      return;
    }
    const streams = (target as unknown as { createEncodedStreams(): LegacyEncodedStreams }).createEncodedStreams();
    this.post({ type: 'transform', ...options, readable: streams.readable, writable: streams.writable }, [
      streams.readable as unknown as Transferable,
      streams.writable as unknown as Transferable,
    ]);
  }

  setupSender(sender: RTCRtpSender, kind: 'audio' | 'video'): void {
    this.attach(sender, { transformId: `s${++transformCounter}`, direction: 'encrypt', kind });
  }

  setupReceiver(receiver: RTCRtpReceiver, kind: 'audio' | 'video', participantId?: string): void {
    const known = this.receiverIds.get(receiver);
    if (known) {
      if (participantId) this.post({ type: 'setTransformParticipant', transformId: known, participantId });
      return;
    }
    const transformId = `r${++transformCounter}`;
    this.receiverIds.set(receiver, transformId);
    this.attach(receiver, { transformId, direction: 'decrypt', kind, participantId });
    if (participantId) this.post({ type: 'setTransformParticipant', transformId, participantId });
  }

  updatePayloadTypes(localSdp?: string, remoteSdp?: string): void {
    if (localSdp) this.post({ type: 'payloadTypes', direction: 'encrypt', map: payloadTypesFromSdp(localSdp) });
    if (remoteSdp) this.post({ type: 'payloadTypes', direction: 'decrypt', map: payloadTypesFromSdp(remoteSdp) });
  }

  participantLeft(participantId: string): void {
    this.post({ type: 'forget', participantId });
  }

  dispose(): void {
    this.host.unregister(this);
    for (const resolve of this.pendingRatchets.values()) resolve(undefined);
    this.pendingRatchets.clear();
    this.worker.onmessage = null;
    if (this.ownsWorker) this.worker.terminate();
  }
}
