declare const RTCRtpScriptTransform: unknown;

/** `RTCRtpScriptTransform` (Safari, Firefox, Chrome 141+): the standard way to transform encoded frames. */
export function hasScriptTransform(): boolean {
  return typeof RTCRtpScriptTransform !== 'undefined';
}

/** Chrome's earlier encoded insertable streams (`createEncodedStreams`). */
export function hasEncodedStreams(): boolean {
  return (
    typeof RTCRtpSender !== 'undefined' &&
    typeof (RTCRtpSender.prototype as unknown as { createEncodedStreams?: unknown }).createEncodedStreams === 'function'
  );
}

/**
 * Whether this browser can end-to-end encrypt media. Kept apart from the
 * manager so checking costs an app nothing: the worker only comes in with
 * a key provider.
 */
export function isE2EESupported(): boolean {
  return hasScriptTransform() || hasEncodedStreams();
}
