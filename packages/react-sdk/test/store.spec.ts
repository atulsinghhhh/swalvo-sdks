jest.mock('@swalvo/rtc', () => require('./helpers/fake-rtc-client'));

import { FakeParticipant, FakeRoom, lastClient, resetFakeRtc } from './helpers/fake-rtc-client';
import { SwalvoStore } from '../src/store';
import type { Room, RTCClient } from '@swalvo/rtc';

describe('SwalvoStore', () => {
  beforeEach(() => {
    resetFakeRtc();
  });

  it('starts at connectionState "idle" before init()/join()', () => {
    const store = new SwalvoStore();
    expect(store.getSnapshot().connectionState).toBe('idle');
  });

  it('init() creates a client and makes it available on the snapshot', () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });

    expect(store.getSnapshot().client).toBeDefined();
  });

  it('join() resolves to "connected" state and populates room/localParticipant', async () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });
    const room = new FakeRoom('room-1');
    lastClient().pendingJoin.resolve(room);

    await store.join('room-1');

    const snapshot = store.getSnapshot();
    expect(snapshot.connectionState).toBe('connected');
    expect(snapshot.room).toBe(room);
    expect(snapshot.localParticipant?.identity).toBe('local-user');
  });

  it('join() sets connectionState "failed" and records the error when the client rejects', async () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });
    lastClient().pendingJoin.reject(new Error('boom'));

    await expect(store.join('room-1')).rejects.toThrow('boom');
    expect(store.getSnapshot().connectionState).toBe('failed');
    expect(store.getSnapshot().error).toBeInstanceOf(Error);
  });

  it('notifies subscribers on every state change', async () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });
    const room = new FakeRoom('room-1');
    lastClient().pendingJoin.resolve(room);
    const listener = jest.fn();
    store.subscribe(listener);

    await store.join('room-1');

    expect(listener).toHaveBeenCalled();
  });

  it('a new snapshot object is produced on every patch (referential inequality for useSyncExternalStore)', async () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });
    const before = store.getSnapshot();
    const room = new FakeRoom('room-1');
    lastClient().pendingJoin.resolve(room);

    await store.join('room-1');

    expect(store.getSnapshot()).not.toBe(before);
  });

  it('reflects a remote participant joining, with a fresh remoteParticipants array reference each time', async () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });
    const room = new FakeRoom('room-1');
    lastClient().pendingJoin.resolve(room);
    await store.join('room-1');
    const before = store.getSnapshot().remoteParticipants;

    const bob = new FakeParticipant('bob');
    room.remoteParticipants.push(bob);
    room.emit('participantJoined', bob);

    const after = store.getSnapshot().remoteParticipants;
    expect(after).not.toBe(before);
    expect(after).toEqual([bob]);
  });

  it('increments reconnectCount on "reconnecting", never resets it back down on its own', async () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });
    const room = new FakeRoom('room-1');
    lastClient().pendingJoin.resolve(room);
    await store.join('room-1');

    room.emit('reconnecting');
    room.emit('reconnecting');

    expect(store.getSnapshot().reconnectCount).toBe(2);
  });

  it('leave() detaches room listeners so a later emit no longer changes the snapshot', async () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });
    const room = new FakeRoom('room-1');
    lastClient().pendingJoin.resolve(room);
    await store.join('room-1');

    await store.leave();
    expect(lastClient().leaveMock).toHaveBeenCalledTimes(1);

    const snapshotAfterLeave = store.getSnapshot();
    room.emit('reconnecting');
    expect(store.getSnapshot()).toBe(snapshotAfterLeave); // no patch happened; listener was detached
  });

  it('dispose() detaches listeners and calls leave() on the client, without throwing if never joined', () => {
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });

    expect(() => store.dispose()).not.toThrow();
    expect(lastClient().leaveMock).toHaveBeenCalledTimes(1);
  });

  it('dispose() during an in-flight join() leaves the room once it resolves instead of attaching it', async () => {
    // Regression test: dispose() racing a still-pending join() used to be a
    // silent no-op (client.leave() has nothing to leave yet — the client
    // only records `currentRoom` once join() resolves), so the room from
    // the join that resolved *after* dispose() got wired into this store's
    // event machinery anyway: 11 listeners nothing would ever remove, and a
    // real room left joined forever with no caller left to leave it.
    const store = new SwalvoStore();
    store.init({ token: 't', endpoint: 'wss://rtc.example.com' });

    const joinPromise = store.join('room-1'); // leaves client.join() pending
    store.dispose(); // caller tears down before the join settles

    const room = new FakeRoom('room-1');
    lastClient().pendingJoin.resolve(room); // the late resolution
    await joinPromise;

    expect(room.leave).toHaveBeenCalledTimes(1); // the orphaned room is cleaned up
    expect(store.getSnapshot().room).toBeUndefined(); // never attached
    expect(store.getSnapshot().connectionState).toBe('connecting'); // untouched by the late resolution; never reaches 'connected'
  });

  describe('attachExisting()', () => {
    it('wires an already-joined room without calling client.join()', () => {
      const store = new SwalvoStore();
      const room = new FakeRoom('room-1');

      store.attachExisting(room as unknown as Room);

      expect(store.getSnapshot().room).toBe(room);
      expect(store.getSnapshot().connectionState).toBe('connected');
      expect(store.getSnapshot().localParticipant?.identity).toBe('local-user');
    });

    it('reacts to events on the adopted room, same as a room from join()', () => {
      const store = new SwalvoStore();
      const room = new FakeRoom('room-1');
      store.attachExisting(room as unknown as Room);

      const bob = new FakeParticipant('bob');
      room.remoteParticipants.push(bob);
      room.emit('participantJoined', bob);

      expect(store.getSnapshot().remoteParticipants).toEqual([bob]);
    });

    it('records the given client on the snapshot when provided', () => {
      const store = new SwalvoStore();
      const room = new FakeRoom('room-1');
      const client = { leave: jest.fn() };

      store.attachExisting(room as unknown as Room, client as unknown as RTCClient);

      expect(store.getSnapshot().client).toBe(client);
    });
  });

  describe('detachExisting()', () => {
    it('unsubscribes from room events without calling client.leave()', () => {
      const store = new SwalvoStore();
      const room = new FakeRoom('room-1');
      const client = { leave: jest.fn() };
      store.attachExisting(room as unknown as Room, client as unknown as RTCClient);

      store.detachExisting();
      const snapshotAfterDetach = store.getSnapshot();
      room.emit('reconnecting');

      expect(client.leave).not.toHaveBeenCalled();
      expect(store.getSnapshot()).toBe(snapshotAfterDetach);
    });
  });
});
