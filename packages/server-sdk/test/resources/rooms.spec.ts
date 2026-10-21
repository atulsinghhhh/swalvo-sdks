import { RoomsResource } from '../../src/resources/rooms';
import type { SwalvoHttpClient } from '../../src/http-client';

describe('RoomsResource', () => {
  it('list() calls GET /v1/rooms', async () => {
    const http = { request: jest.fn().mockResolvedValue([]) };
    const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

    await resource.list();

    expect(http.request).toHaveBeenCalledWith('/v1/rooms');
  });

  it('get() calls GET /v1/rooms/:id', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'r1' }) };
    const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

    await resource.get('r1');

    expect(http.request).toHaveBeenCalledWith('/v1/rooms/r1');
  });

  it('create() POSTs the room name', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'r1', name: 'lobby' }) };
    const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

    await resource.create({ name: 'lobby' });

    expect(http.request).toHaveBeenCalledWith('/v1/rooms', { method: 'POST', body: { name: 'lobby' } });
  });

  it('create() passes e2ee through for an end-to-end encrypted room', async () => {
    const http = { request: jest.fn().mockResolvedValue({ id: 'r1', name: 'vault', e2ee: true }) };
    const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

    const room = await resource.create({ name: 'vault', e2ee: true });

    expect(http.request).toHaveBeenCalledWith('/v1/rooms', { method: 'POST', body: { name: 'vault', e2ee: true } });
    expect(room.e2ee).toBe(true);
  });

  it('delete() soft-closes via DELETE, never a hard destroy', async () => {
    const http = { request: jest.fn().mockResolvedValue(undefined) };
    const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

    await resource.delete('r1');

    expect(http.request).toHaveBeenCalledWith('/v1/rooms/r1', { method: 'DELETE' });
  });

  describe('participants', () => {
    it('list() returns the live participant list', async () => {
      const http = {
        request: jest.fn().mockResolvedValue([{ identity: 'alice', joinedAt: '2026-01-01', tracks: [] }]),
      };
      const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

      const participants = await resource.participants.list('r1');

      expect(http.request).toHaveBeenCalledWith('/v1/rooms/r1/participants');
      expect(participants).toHaveLength(1);
    });

    it('list() passes through null (SFU unreachable) rather than fabricating an empty array', async () => {
      const http = { request: jest.fn().mockResolvedValue(null) };
      const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

      await expect(resource.participants.list('r1')).resolves.toBeNull();
    });

    it('get() finds one participant by identity from the live list', async () => {
      const http = {
        request: jest.fn().mockResolvedValue([
          { identity: 'alice', joinedAt: '2026-01-01', tracks: [] },
          { identity: 'bob', joinedAt: '2026-01-01', tracks: [] },
        ]),
      };
      const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

      const bob = await resource.participants.get('r1', 'bob');
      expect(bob?.identity).toBe('bob');

      const missing = await resource.participants.get('r1', 'carol');
      expect(missing).toBeNull();
    });

    it('get() returns null (not throw) when the SFU is unreachable', async () => {
      const http = { request: jest.fn().mockResolvedValue(null) };
      const resource = new RoomsResource(http as unknown as SwalvoHttpClient);

      await expect(resource.participants.get('r1', 'alice')).resolves.toBeNull();
    });
  });

  describe('server moderation and metadata', () => {
    function build(result: unknown = undefined) {
      const http = { request: jest.fn().mockResolvedValue(result) };
      return { http, resource: new RoomsResource(http as unknown as SwalvoHttpClient) };
    }

    it('removeParticipant() POSTs to the remove route, encoding path segments', async () => {
      const { http, resource } = build();
      await resource.removeParticipant('my room', 'a/b');
      expect(http.request).toHaveBeenCalledWith('/v1/rooms/my%20room/participants/a%2Fb/remove', { method: 'POST' });
    });

    it('muteParticipant() POSTs the mute and requires a trackId or kind', async () => {
      const { http, resource } = build();
      await resource.muteParticipant('r1', 'alice', { kind: 'audio', muted: true });
      expect(http.request).toHaveBeenCalledWith('/v1/rooms/r1/participants/alice/mute', {
        method: 'POST',
        body: { kind: 'audio', muted: true },
      });
      await expect(resource.muteParticipant('r1', 'alice', { muted: true } as never)).rejects.toThrow(TypeError);
      expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('updateParticipantPermissions() PATCHes the permissions route', async () => {
      const { http, resource } = build({ publish: false });
      await expect(resource.updateParticipantPermissions('r1', 'alice', { publish: false })).resolves.toEqual({
        publish: false,
      });
      expect(http.request).toHaveBeenCalledWith('/v1/rooms/r1/participants/alice/permissions', {
        method: 'PATCH',
        body: { publish: false },
      });
    });

    it('updateParticipant() PATCHes metadata and attributes (null deletes)', async () => {
      const { http, resource } = build({ identity: 'alice', metadata: 'm', attributes: {} });
      await resource.updateParticipant('r1', 'alice', { metadata: 'm', attributes: { hand: null } });
      expect(http.request).toHaveBeenCalledWith('/v1/rooms/r1/participants/alice', {
        method: 'PATCH',
        body: { metadata: 'm', attributes: { hand: null } },
      });
    });

    it('sendData() base64-encodes the payload, passes options through, and never retries', async () => {
      const { http, resource } = build({ messageId: 'm1' });
      await expect(
        resource.sendData('r1', 'hi', { topic: 'chat', destinationIdentities: ['bob'], reliable: false }),
      ).resolves.toEqual({ messageId: 'm1' });
      expect(http.request).toHaveBeenCalledWith('/v1/rooms/r1/data', {
        method: 'POST',
        retryable: false,
        body: { payload: 'aGk=', topic: 'chat', destinationIdentities: ['bob'], reliable: false },
      });

      await resource.sendData('r1', new Uint8Array([1, 2, 3]));
      expect(http.request).toHaveBeenLastCalledWith('/v1/rooms/r1/data', {
        method: 'POST',
        retryable: false,
        body: { payload: 'AQID' },
      });
    });
  });
});
