/**
 * Phase 11 addition. Feature-detects what the SDK actually needs, instead
 * of keeping a user-agent allowlist that goes stale the moment you write
 * it. See docs/sdk/web.md#browser-support for the documented matrix.
 */
export interface BrowserSupportDetails {
  supported: boolean;
  missing: string[];
}

export function getBrowserSupportDetails(): BrowserSupportDetails {
  const missing: string[] = [];

  if (typeof RTCPeerConnection === 'undefined') missing.push('RTCPeerConnection');
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)
    missing.push('navigator.mediaDevices.getUserMedia');
  if (typeof WebSocket === 'undefined') missing.push('WebSocket');

  return { supported: missing.length === 0, missing };
}

/** A simple yes/no wrapper over `getBrowserSupportDetails()`. */
export function isBrowserSupported(): boolean {
  return getBrowserSupportDetails().supported;
}
