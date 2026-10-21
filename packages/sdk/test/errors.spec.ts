import { RTCError, isRTCError } from '../src/errors';

describe('RTCError', () => {
  it('carries a stable code, message, and optional cause', () => {
    const cause = new Error('underlying');
    const error = new RTCError('TOKEN_EXPIRED', 'token has expired', cause);

    expect(error.code).toBe('TOKEN_EXPIRED');
    expect(error.message).toBe('token has expired');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('RTCError');
    expect(error).toBeInstanceOf(Error);
  });

  it('isRTCError narrows RTCError instances only', () => {
    expect(isRTCError(new RTCError('TIMEOUT', 'timed out'))).toBe(true);
    expect(isRTCError(new Error('plain'))).toBe(false);
    expect(isRTCError('not an error')).toBe(false);
    expect(isRTCError(undefined)).toBe(false);
  });
});
