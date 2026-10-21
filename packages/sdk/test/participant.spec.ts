import { LocalParticipant, RemoteParticipant } from '../src/participant';

describe('Participant', () => {
  it('exposes identity and metadata set at construction', () => {
    const participant = new RemoteParticipant('alice', 'opaque-metadata');
    expect(participant.identity).toBe('alice');
    expect(participant.metadata).toBe('opaque-metadata');
  });

  it('metadata is undefined when not provided', () => {
    const participant = new RemoteParticipant('bob');
    expect(participant.metadata).toBeUndefined();
  });

  it('_setIdentity() updates the identity (used once, post-connect, by the SFU adapter)', () => {
    const participant = new LocalParticipant('');
    expect(participant.identity).toBe('');

    participant._setIdentity('confirmed-identity');

    expect(participant.identity).toBe('confirmed-identity');
  });
});

describe('LocalParticipant / RemoteParticipant', () => {
  it('start with an empty, independent tracks array', () => {
    const local = new LocalParticipant('alice');
    const remote = new RemoteParticipant('bob');

    expect(local.tracks).toEqual([]);
    expect(remote.tracks).toEqual([]);
    expect(local.tracks).not.toBe(remote.tracks);
  });
});
