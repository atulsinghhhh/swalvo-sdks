export interface PlatformInfo {
  platform: string;
  browser: string;
  networkType?: string;
}

/**
 * Best-effort, browser-only detection. Never throws, never assumes
 * `navigator` exists, since unit tests run under Node. Coarse on purpose:
 * a browser/device category (Phase 9 spec §4), not a fingerprinting
 * library.
 */
export function detectPlatform(): PlatformInfo {
  if (typeof navigator === 'undefined') {
    return { platform: 'unknown', browser: 'unknown' };
  }

  const ua = navigator.userAgent ?? '';
  let browser = 'unknown';
  if (/edg\//i.test(ua)) browser = 'edge';
  else if (/firefox|fxios/i.test(ua)) browser = 'firefox';
  else if (/chrome|crios/i.test(ua)) browser = 'chrome';
  else if (/safari/i.test(ua)) browser = 'safari';

  let platform = 'web';
  if (/android/i.test(ua)) platform = 'android';
  else if (/iphone|ipad|ipod/i.test(ua)) platform = 'ios';

  const connection = (navigator as unknown as { connection?: { effectiveType?: string } }).connection;
  const networkType = typeof connection?.effectiveType === 'string' ? connection.effectiveType : undefined;

  return { platform, browser, networkType };
}
