import { TokensResource } from '../../src/resources/tokens';
import type { SwalvoHttpClient } from '../../src/http-client';

describe('TokensResource', () => {
  it('POSTs to /v1/rooms/:room/rtc-tokens with the Swalvo permission vocabulary', async () => {
    const http = { request: jest.fn().mockResolvedValue({ token: 't', expiresAt: '2026-01-01T00:00:00Z' }) };
    const resource = new TokensResource(http as unknown as SwalvoHttpClient);

    const result = await resource.create({
      room: 'room-123',
      identity: 'user-42',
      permissions: { publishAudio: true, publishVideo: true, subscribe: true },
      expiresIn: 3600,
    });

    expect(http.request).toHaveBeenCalledWith('/v1/rooms/room-123/rtc-tokens', {
      method: 'POST',
      body: {
        participantIdentity: 'user-42',
        permissions: { publishAudio: true, publishVideo: true, subscribe: true },
        ttlSeconds: 3600,
        metadata: undefined,
        attributes: undefined,
      },
    });
    expect(result.token).toBe('t');
  });

  it('never logs the returned token; it is just returned data, not written anywhere', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const http = { request: jest.fn().mockResolvedValue({ token: 'super-secret-rtc-token' }) };
    const resource = new TokensResource(http as unknown as SwalvoHttpClient);

    await resource.create({ room: 'room-1', identity: 'alice' });

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('passes metadata, attributes and updateOwnMetadata through', async () => {
    const http = { request: jest.fn().mockResolvedValue({ token: 't' }) };
    const resource = new TokensResource(http as unknown as SwalvoHttpClient);

    await resource.create({
      room: 'r1',
      identity: 'alice',
      permissions: { join: true, updateOwnMetadata: true },
      metadata: '{"name":"Alice"}',
      attributes: { role: 'host' },
    });

    expect(http.request.mock.calls[0][1].body).toEqual({
      participantIdentity: 'alice',
      permissions: { join: true, updateOwnMetadata: true },
      ttlSeconds: undefined,
      metadata: '{"name":"Alice"}',
      attributes: { role: 'host' },
    });
  });
});
