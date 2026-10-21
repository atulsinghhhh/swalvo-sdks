/**
 * The E2EE transform worker. Bundled on its own (IIFE) and inlined into
 * the SDK as a string by `tsup.config.ts`, so it is only reachable through
 * `createKeyProvider()` / `createSharedKeyProvider()` and an app that never
 * calls them never ships it. Also published as `@swalvo/rtc/e2ee-worker`
 * for apps whose CSP forbids `blob:` workers (`e2ee.worker`).
 *
 * Two ways frames arrive:
 * - `RTCRtpScriptTransform` (Safari, Firefox, recent Chrome): the
 *   `rtctransform` event hands us a transformer with `options`.
 * - Chrome's legacy encoded insertable streams: the main thread calls
 *   `createEncodedStreams()` and transfers the streams in a `transform`
 *   message.
 */
import type { E2EECodec } from './crypto';
import { FrameCryptorCore } from './frame-cryptor';
import {
  codecFromMimeType,
  type MainToWorkerMessage,
  type TransformOptions,
  type WorkerToMainMessage,
} from './worker-protocol';

interface EncodedFrame {
  data: ArrayBuffer;
  timestamp: number;
  type?: 'key' | 'delta' | 'empty';
  getMetadata(): { synchronizationSource?: number; payloadType?: number; mimeType?: string };
}

interface WorkerScope {
  postMessage(message: WorkerToMainMessage): void;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
  onrtctransform?:
    | ((event: {
        transformer: { readable: ReadableStream; writable: WritableStream; options: TransformOptions };
      }) => void)
    | null;
}

const scope = self as unknown as WorkerScope;

let core: FrameCryptorCore | undefined;
let localParticipantId = '';
const transformParticipants = new Map<string, string>();
const payloadTypes: Record<'encrypt' | 'decrypt', Record<number, E2EECodec>> = { encrypt: {}, decrypt: {} };

function post(message: WorkerToMainMessage): void {
  scope.postMessage(message);
}

function ensureCore(sharedKey = true, ratchetWindow?: number): FrameCryptorCore {
  if (!core) {
    core = new FrameCryptorCore({
      sharedKey,
      ratchetWindow,
      onStateChanged: (participantId, direction, state) => post({ type: 'state', participantId, direction, state }),
      onKeyRatcheted: (participantId, keyIndex, material) =>
        post({ type: 'ratcheted', participantId, keyIndex, material }),
    });
  }
  return core;
}

function looksLikeH264(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
}

function codecFor(frame: EncodedFrame, options: TransformOptions, data: Uint8Array): E2EECodec {
  if (options.kind === 'audio') return 'opus';
  let metadata: ReturnType<EncodedFrame['getMetadata']> = {};
  try {
    metadata = frame.getMetadata();
  } catch {
    // older engines
  }
  return (
    codecFromMimeType(metadata.mimeType) ??
    (metadata.payloadType !== undefined ? payloadTypes[options.direction][metadata.payloadType] : undefined) ??
    options.codec ??
    (looksLikeH264(data) ? 'h264' : 'vp8')
  );
}

function pipe(readable: ReadableStream, writable: WritableStream, options: TransformOptions): void {
  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      const cryptor = core;
      if (!cryptor) {
        // Not initialised yet: never let plaintext out of a sender.
        if (options.direction === 'decrypt') controller.enqueue(frame);
        return;
      }
      if (!cryptor.enabled) {
        // A room without e2ee: frames pass through untouched.
        controller.enqueue(frame);
        return;
      }
      const data = new Uint8Array(frame.data);
      const info = { codec: codecFor(frame, options, data), isKeyFrame: frame.type === 'key' };
      let out: Uint8Array | null;
      if (options.direction === 'encrypt') {
        const ssrc = frame.getMetadata().synchronizationSource ?? 0;
        out = await cryptor.encrypt(localParticipantId, data, info, ssrc, frame.timestamp);
      } else {
        const participantId = transformParticipants.get(options.transformId) ?? options.participantId;
        if (!participantId) {
          // Frames before signaling has said whose track this is: drop.
          return;
        }
        out = await cryptor.decrypt(participantId, data, info);
      }
      if (!out) return;
      if (out !== data) {
        frame.data = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      }
      controller.enqueue(frame);
    },
  });
  readable
    .pipeThrough(transform)
    .pipeTo(writable)
    .catch((error: unknown) => post({ type: 'error', message: String((error as Error)?.message ?? error) }));
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      localParticipantId = message.localParticipantId;
      ensureCore(message.sharedKey, message.ratchetWindow).enabled = message.enabled;
      break;
    case 'setKey':
      void ensureCore()
        .setKey(message.participantId, message.material, message.keyIndex)
        .catch((error: Error) => post({ type: 'error', message: error.message }));
      break;
    case 'ratchet':
      void ensureCore()
        .ratchet(message.participantId, message.keyIndex)
        .then((material) => {
          if (material) {
            post({
              type: 'ratcheted',
              participantId: message.participantId,
              keyIndex: message.keyIndex ?? -1,
              material,
              requestId: message.requestId,
            });
          }
        })
        .catch((error: Error) => post({ type: 'error', message: error.message }));
      break;
    case 'enable':
      ensureCore().enabled = message.enabled;
      break;
    case 'setLocalParticipant':
      localParticipantId = message.participantId;
      break;
    case 'setTransformParticipant':
      transformParticipants.set(message.transformId, message.participantId);
      break;
    case 'payloadTypes':
      payloadTypes[message.direction] = message.map;
      break;
    case 'forget':
      core?.forget(message.participantId);
      break;
    case 'transform': {
      const { readable, writable, type: _type, ...options } = message;
      pipe(readable, writable, options);
      break;
    }
    default:
      break;
  }
};

scope.onrtctransform = (event) => {
  const { readable, writable, options } = event.transformer;
  pipe(readable, writable, options);
};
