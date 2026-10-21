import { toMediaError } from '../src/internal/media/errors';

function domException(name: string): Error {
  const error = new Error('boom');
  error.name = name;
  return error;
}

describe('toMediaError', () => {
  it('maps NotAllowedError to CAMERA_PERMISSION_DENIED for a camera track', () => {
    const error = toMediaError(domException('NotAllowedError'), 'camera');
    expect(error.code).toBe('CAMERA_PERMISSION_DENIED');
  });

  it('maps NotAllowedError to MICROPHONE_PERMISSION_DENIED for a microphone track', () => {
    const error = toMediaError(domException('NotAllowedError'), 'microphone');
    expect(error.code).toBe('MICROPHONE_PERMISSION_DENIED');
  });

  it('maps NotAllowedError to the generic PERMISSION_DENIED for a screen share track', () => {
    const error = toMediaError(domException('NotAllowedError'), 'screenShare');
    expect(error.code).toBe('PERMISSION_DENIED');
  });

  it('maps NotFoundError to DEVICE_NOT_FOUND', () => {
    const error = toMediaError(domException('NotFoundError'), 'camera');
    expect(error.code).toBe('DEVICE_NOT_FOUND');
  });

  it('maps NotReadableError (device already in use) to MEDIA_ERROR', () => {
    const error = toMediaError(domException('NotReadableError'), 'microphone');
    expect(error.code).toBe('MEDIA_ERROR');
  });

  it('falls back to MEDIA_ERROR for an unrecognized or missing error', () => {
    expect(toMediaError(domException('SomeWeirdError'), 'camera').code).toBe('MEDIA_ERROR');
    expect(toMediaError(undefined, 'camera').code).toBe('MEDIA_ERROR');
  });

  it('always preserves the original error as `cause`', () => {
    const original = domException('NotFoundError');
    const error = toMediaError(original, 'camera');
    expect(error.cause).toBe(original);
  });
});
