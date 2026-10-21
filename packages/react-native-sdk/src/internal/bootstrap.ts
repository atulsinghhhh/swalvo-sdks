import { registerGlobals } from 'react-native-webrtc';

let registered = false;

/**
 * Installs the WebRTC globals React Native doesn't ship with.
 *
 * This one function is the entire reason `@swalvo/rtc`, a package written
 * for browsers, runs unmodified on a phone. `registerGlobals()` drops
 * `RTCPeerConnection`, `navigator.mediaDevices`, `MediaStream` and the rest
 * onto the global object, backed by the native iOS and Android WebRTC
 * implementation in `react-native-webrtc`. After that, nothing in
 * `@swalvo/rtc` can tell it isn't in a browser.
 *
 * It matters more since Swalvo's own SFU replaced LiveKit. The web SDK now
 * drives `RTCPeerConnection` directly rather than handing off to a client
 * library, so what it wants from the platform is precisely the standard
 * WebRTC API. Which is precisely what `react-native-webrtc` gives it.
 *
 * And that's the whole architecture of this package. Swalvo's RTC and chat
 * logic is shared with web, and only what genuinely differs lives here:
 * rendering, permissions, app lifecycle, audio routing.
 *
 * Has to run before any Swalvo client is constructed, and exactly once.
 * `new Swalvo(...)` calls it for you so nobody has to remember. Calling it
 * yourself earlier, in `index.js` before the first render, is supported and
 * occasionally handy.
 */
export function bootstrapSwalvoNative(): void {
  if (registered) {
    return;
  }
  registered = true;

  registerGlobals();
  installBase64Polyfill();
}

/** @internal Test-only. Lets a suite assert the once-only behaviour. */
export function __resetBootstrapForTests(): void {
  registered = false;
}

/**
 * `@swalvo/chat` decodes its token payload with `atob`, to get the user id
 * and expiry without a round trip. Hermes has shipped `atob`/`btoa` since
 * React Native 0.74; older runtimes and some JSC configurations haven't.
 * Rather than declare a version floor we don't otherwise need, just fill
 * the gap where it exists.
 *
 * Minimal on purpose. It decodes standard base64 and nothing else, which is
 * all the JWT path ever asks of it. Not a general-purpose polyfill, and it
 * doesn't pretend to be one.
 */
function installBase64Polyfill(): void {
  const globalRef = globalThis as typeof globalThis & {
    atob?: (input: string) => string;
    btoa?: (input: string) => string;
  };

  if (typeof globalRef.atob !== 'function') {
    globalRef.atob = (input: string): string => {
      const normalized = input.replace(/[=]+$/, '');
      let output = '';
      let buffer = 0;
      let bits = 0;

      for (const char of normalized) {
        const value = BASE64_ALPHABET.indexOf(char);
        if (value === -1) {
          throw new Error('atob: input is not valid base64');
        }
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          output += String.fromCharCode((buffer >> bits) & 0xff);
        }
      }

      return output;
    };
  }

  if (typeof globalRef.btoa !== 'function') {
    globalRef.btoa = (input: string): string => {
      let output = '';
      for (let i = 0; i < input.length; i += 3) {
        const chunk = [input.charCodeAt(i), input.charCodeAt(i + 1), input.charCodeAt(i + 2)];
        const triplet = (chunk[0] << 16) | ((chunk[1] || 0) << 8) | (chunk[2] || 0);

        output += BASE64_ALPHABET[(triplet >> 18) & 0x3f];
        output += BASE64_ALPHABET[(triplet >> 12) & 0x3f];
        output += Number.isNaN(chunk[1]) ? '=' : BASE64_ALPHABET[(triplet >> 6) & 0x3f];
        output += Number.isNaN(chunk[2]) ? '=' : BASE64_ALPHABET[triplet & 0x3f];
      }
      return output;
    };
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
