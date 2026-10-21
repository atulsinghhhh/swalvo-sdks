import { RTCError, type RTCErrorCode } from '@swalvo/rtc';

/**
 * Mobile brings exactly one failure mode the web SDK doesn't have: an
 * operating system that can refuse camera or microphone access outright,
 * permanently, with no way for the app to ask again.
 *
 * Everything else already has a code in `@swalvo/rtc`: expired tokens,
 * failed connections, missing rooms, unavailable devices. Reusing those is
 * the entire point. Someone moving from web to mobile should be catching
 * the same `RTCError` with the same `code`, not learning a second error
 * vocabulary (Phase 13 spec §14).
 *
 * So what this file adds is a subclass carrying extra mobile-specific
 * context, not a new hierarchy. `SwalvoPermissionError` *is* an `RTCError`,
 * and existing `catch (e) { if (isRTCError(e)) ... }` code carries on
 * working untouched.
 */
export type SwalvoPermissionKind = 'camera' | 'microphone';

/** What the OS said, normalised across iOS and Android. */
export type SwalvoPermissionStatus =
  | 'granted'
  /** Refused this time round. Asking again might still prompt. */
  | 'denied'
  /**
   * Refused permanently. Android's "don't ask again", or iOS after any
   * refusal at all. Prompting again does nothing; the user has to change it
   * in Settings, and your UI had better say so.
   */
  | 'blocked'
  /** Not determined yet. No prompt has been shown. */
  | 'undetermined'
  /** The platform doesn't gate this permission, or we can't tell. */
  | 'unavailable';

/**
 * Thrown when the OS refuses camera or microphone access.
 *
 * Carries `blocked` because the right UI is completely different either
 * way: a plain denial can be retried with another prompt, a blocked one has
 * to send the user to Settings. Failing silently here, which §3 of the spec
 * explicitly forbids, is how apps end up showing a black rectangle and no
 * explanation.
 */
export class SwalvoPermissionError extends RTCError {
  readonly permission: SwalvoPermissionKind;
  readonly status: SwalvoPermissionStatus;

  constructor(permission: SwalvoPermissionKind, status: SwalvoPermissionStatus, cause?: unknown) {
    super(
      permission === 'camera' ? 'CAMERA_PERMISSION_DENIED' : 'MICROPHONE_PERMISSION_DENIED',
      status === 'blocked'
        ? `${permission} access is blocked. The user must enable it in the system settings; prompting again will not show a dialog.`
        : `${permission} access was denied.`,
      cause,
    );
    this.name = 'SwalvoPermissionError';
    this.permission = permission;
    this.status = status;
  }

  /** True when re-prompting is pointless and only Settings will do. */
  get requiresSettings(): boolean {
    return this.status === 'blocked';
  }
}

export function isSwalvoPermissionError(value: unknown): value is SwalvoPermissionError {
  return value instanceof SwalvoPermissionError;
}

/**
 * Turns a `getUserMedia` rejection into a permission error, where that's
 * what it actually was.
 *
 * iOS gives React Native no permissions API without a native module, so a
 * denied camera only ever surfaces as a `getUserMedia` failure. Reading the
 * DOMException name is how we get that back into something a developer can
 * branch on.
 */
export function toPermissionError(permission: SwalvoPermissionKind, error: unknown): SwalvoPermissionError | undefined {
  const name = (error as { name?: string } | undefined)?.name;
  const message = String((error as { message?: string } | undefined)?.message ?? '');

  const denied =
    name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|not allowed/i.test(message);

  return denied ? new SwalvoPermissionError(permission, 'denied', error) : undefined;
}

// Re-exported so a mobile app can catch everything Swalvo throws without
// having to import @swalvo/rtc as well.
export { RTCError, isRTCError } from '@swalvo/rtc';
export type { RTCErrorCode };
