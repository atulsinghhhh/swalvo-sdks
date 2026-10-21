// jsdom has neither TextEncoder/TextDecoder nor any WebRTC media type, and
// @swalvo/rtc reaches for both while its module graph loads. So the
// polyfills have to be in place first. Same shim as
// packages/sdk/test/setup.ts, for the same reason.
import { TextDecoder, TextEncoder } from 'util';

if (typeof globalThis.TextEncoder === 'undefined') {
  (globalThis as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  (globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder =
    TextDecoder as unknown as typeof globalThis.TextDecoder;
}
if (typeof (globalThis as { MediaStream?: unknown }).MediaStream === 'undefined') {
  class FakeMediaStream {
    getTracks(): MediaStreamTrack[] {
      return [];
    }
  }
  (globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeMediaStream;
}
