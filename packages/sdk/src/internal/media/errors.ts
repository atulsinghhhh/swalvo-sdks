import { RTCError } from '../../errors';
import type { TrackKind } from '../../track';

/**
 * Maps a raw getUserMedia/getDisplayMedia failure onto one of our typed
 * error codes.
 *
 * The whole classification is a short read of the `DOMException` names the
 * Media Capture spec defines, so Swalvo owns it instead of pulling in a
 * library.
 *
 * Those names come from the spec's own error list (getUserMedia §9.2), not
 * from any one browser's quirks. Every engine reports them. A name we
 * don't recognise falls through to a generic `MEDIA_ERROR` instead of
 * getting guessed at.
 */
export function toMediaError(error: unknown, kind: TrackKind): RTCError {
  const name = errorName(error);

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // SecurityError is what a browser raises when the page isn't a
      // secure context. From the developer's side that's a permission
      // problem, and the message spells out which kind.
      return new RTCError(permissionDeniedCode(kind), `Permission to use the ${label(kind)} was denied`, error);

    case 'NotFoundError':
    case 'OverconstrainedError':
      // OverconstrainedError means nothing satisfies the constraints. In
      // practice that's a deviceId that no longer exists, which a
      // developer handles exactly the same way as "not found".
      return new RTCError('DEVICE_NOT_FOUND', `No ${label(kind)} device matched`, error);

    case 'NotReadableError':
      return new RTCError('MEDIA_ERROR', `The ${label(kind)} is already in use by another application`, error);

    case 'AbortError':
      return new RTCError('MEDIA_ERROR', `Capturing the ${label(kind)} was aborted`, error);

    case 'TypeError':
      // Empty or malformed constraints. That's a programming error, not a
      // device one, so say so.
      return new RTCError('MEDIA_ERROR', `Invalid ${label(kind)} capture constraints`, error);

    default:
      return new RTCError('MEDIA_ERROR', `Could not access the ${label(kind)}`, error);
  }
}

function errorName(error: unknown): string | undefined {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name;
  }
  // Not every environment has DOMException (some test runners, older
  // React Native), and `error.name` is there regardless.
  if (error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name;
  }
  return undefined;
}

/** What a developer calls it, rather than what the SDK calls it internally. */
function label(kind: TrackKind): string {
  return kind === 'screenShare' ? 'screen' : kind;
}

function permissionDeniedCode(
  kind: TrackKind,
): 'CAMERA_PERMISSION_DENIED' | 'MICROPHONE_PERMISSION_DENIED' | 'PERMISSION_DENIED' {
  if (kind === 'camera') return 'CAMERA_PERMISSION_DENIED';
  if (kind === 'microphone') return 'MICROPHONE_PERMISSION_DENIED';
  return 'PERMISSION_DENIED';
}
