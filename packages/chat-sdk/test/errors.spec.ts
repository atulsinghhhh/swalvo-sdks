import {
  SwalvoAttachmentError,
  SwalvoChatAuthenticationError,
  SwalvoChatConnectionError,
  SwalvoChatError,
  SwalvoChatPermissionError,
  SwalvoMessageError,
  SwalvoRateLimitError,
  SwalvoRoomError,
  isSwalvoChatError,
  toSwalvoChatError,
} from '../src/errors';

describe('toSwalvoChatError', () => {
  it.each([
    ['INVALID_TOKEN', SwalvoChatAuthenticationError],
    ['TOKEN_EXPIRED', SwalvoChatAuthenticationError],
    ['TOKEN_REVOKED', SwalvoChatAuthenticationError],
    ['UNAUTHORIZED', SwalvoChatAuthenticationError],
    ['PERMISSION_DENIED', SwalvoChatPermissionError],
    ['NOT_A_MEMBER', SwalvoChatPermissionError],
    ['ROOM_NOT_FOUND', SwalvoRoomError],
    ['NOT_IN_ROOM', SwalvoRoomError],
    ['CONVERSATION_ARCHIVED', SwalvoRoomError],
    ['MESSAGE_TOO_LARGE', SwalvoMessageError],
    ['MESSAGE_NOT_FOUND', SwalvoMessageError],
    ['INVALID_CURSOR', SwalvoMessageError],
    ['ATTACHMENT_TOO_LARGE', SwalvoAttachmentError],
    ['ATTACHMENTS_NOT_CONFIGURED', SwalvoAttachmentError],
    ['CONNECTION_FAILED', SwalvoChatConnectionError],
    ['TIMEOUT', SwalvoChatConnectionError],
  ])('maps %s to the specific error class a developer would catch', (code, expected) => {
    const error = toSwalvoChatError(code, 'something happened');
    expect(error).toBeInstanceOf(expected);
    expect(error.code).toBe(code);
  });

  it('carries retryAfterSeconds through on a rate limit', () => {
    const error = toSwalvoChatError('RATE_LIMITED', 'slow down', { retryAfterSeconds: 12 });
    expect(error).toBeInstanceOf(SwalvoRateLimitError);
    expect((error as SwalvoRateLimitError).retryAfterSeconds).toBe(12);
  });

  it('falls back to the base class for a code this SDK version does not know', () => {
    const error = toSwalvoChatError('SOME_FUTURE_CODE', 'from a newer server');
    expect(error).toBeInstanceOf(SwalvoChatError);
    expect(error.code).toBe('SOME_FUTURE_CODE');
  });

  it('defaults to INTERNAL_ERROR when the server sent no code at all', () => {
    expect(toSwalvoChatError(undefined, 'unknown').code).toBe('INTERNAL_ERROR');
  });
});

describe('isSwalvoChatError', () => {
  it('recognises every subclass, so one catch covers the whole SDK', () => {
    expect(isSwalvoChatError(new SwalvoRateLimitError('x'))).toBe(true);
    expect(isSwalvoChatError(new SwalvoRoomError('x'))).toBe(true);
    expect(isSwalvoChatError(new Error('plain'))).toBe(false);
    expect(isSwalvoChatError('not an error')).toBe(false);
  });
});

describe('error surface', () => {
  it('keeps the underlying cause without exposing it in the message', () => {
    const cause = new TypeError('fetch failed: ECONNREFUSED 10.0.0.1:5432');
    const error = new SwalvoChatConnectionError('Could not reach Swalvo', 'NETWORK_ERROR', cause);
    expect(error.message).toBe('Could not reach Swalvo');
    expect(error.cause).toBe(cause);
  });

  it('sets a distinct name per class so stack traces and logs read clearly', () => {
    expect(new SwalvoChatAuthenticationError('x').name).toBe('SwalvoChatAuthenticationError');
    expect(new SwalvoRateLimitError('x').name).toBe('SwalvoRateLimitError');
  });
});

describe('deprecated Raven* aliases', () => {
  it('are the same classes and functions as the Swalvo* names', async () => {
    const legacy = await import('../src/index');
    expect(legacy.RavenChatError).toBe(legacy.SwalvoChatError);
    expect(legacy.RavenRateLimitError).toBe(legacy.SwalvoRateLimitError);
    expect(legacy.isRavenChatError).toBe(legacy.isSwalvoChatError);
    const error = new legacy.RavenRoomError('x');
    expect(error).toBeInstanceOf(legacy.SwalvoRoomError);
    expect(error).toBeInstanceOf(legacy.RavenChatError);
  });
});
