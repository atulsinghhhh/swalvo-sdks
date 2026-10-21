// jsdom hands us `atob` and `fetch` but not `crypto.randomUUID`, which the
// SDK uses for idempotency keys. Polyfill only what's actually missing.
import { webcrypto } from 'crypto';

if (typeof globalThis.crypto === 'undefined') {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
