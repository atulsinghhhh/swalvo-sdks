// jsdom, jest's browser-ish test environment, has neither
// TextEncoder/TextDecoder nor any WebRTC type. This polyfills just enough
// for the SDK to import and run. Tests that need to actually drive a
// connection install richer fakes themselves (test/helpers/fake-webrtc.ts).
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
