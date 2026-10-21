import type { E2EEState } from './frame-cryptor';

export type { E2EEState };

/**
 * What the RTC adapter needs from E2EE, and all it imports. Type-only, so
 * the adapter never pulls the worker into a bundle; the implementation
 * arrives through the key provider the app passed in `RTCClientConfig.e2ee`.
 *
 * @internal
 */
export interface E2EEController {
  /** True when the PeerConnection must be built with `encodedInsertableStreams: true` (Chrome's legacy API). */
  readonly needsInsertableStreams: boolean;
  /** Called on every `room.joined`. `enabled` is the room's `e2ee` flag. */
  start(roomId: string, localParticipantId: string, enabled: boolean): Promise<void>;
  setupSender(sender: RTCRtpSender, kind: 'audio' | 'video'): void;
  setupReceiver(receiver: RTCRtpReceiver, kind: 'audio' | 'video', participantId?: string): void;
  updatePayloadTypes(localSdp?: string, remoteSdp?: string): void;
  participantLeft(participantId: string): void;
  setStateListener(listener: (participantId: string, direction: 'encrypt' | 'decrypt', state: E2EEState) => void): void;
  dispose(): void;
}

/** @internal The hook a key provider exposes to the adapter. */
export interface E2EEControllerFactory {
  createController(options: { worker?: Worker; log?: (message: string) => void }): E2EEController;
}

/** End-to-end encryption options for `RTCClientConfig.e2ee`. */
export interface E2EEOptions {
  /** From `createSharedKeyProvider(passphrase)` or `createKeyProvider()`. */
  keyProvider: E2EEKeyProviderLike;
  /**
   * A worker to run the frame transforms in. Defaults to one built from an
   * inlined `blob:` URL; pass `new Worker(new URL('@swalvo/rtc/e2ee-worker', import.meta.url))`
   * (or wherever your bundler puts it) when your CSP has no `worker-src blob:`.
   */
  worker?: Worker;
}

/** Structural type of a key provider, so the config type does not import the implementation. */
export interface E2EEKeyProviderLike {
  readonly sharedKey: boolean;
  readonly ratchetWindow: number;
}
