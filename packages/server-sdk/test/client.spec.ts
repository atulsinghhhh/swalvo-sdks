import { Swalvo } from '../src/client';
import { SwalvoError } from '../src/errors';

describe('Swalvo', () => {
  it('throws synchronously when constructed without an apiKey', () => {
    // @ts-expect-error leaving out the required field on purpose
    expect(() => new Swalvo({})).toThrow(SwalvoError);
  });

  it('exposes all documented resources', () => {
    const swalvo = new Swalvo({ apiKey: 'k' });

    expect(swalvo.projects).toBeDefined();
    expect(swalvo.tokens).toBeDefined();
    expect(swalvo.rooms).toBeDefined();
    expect(swalvo.rooms.participants).toBeDefined();
    expect(swalvo.connections).toBeDefined();
    expect(swalvo.errors).toBeDefined();
    expect(swalvo.metrics).toBeDefined();
    expect(swalvo.diagnostics).toBeDefined();
    expect(swalvo.chat).toBeDefined();
    expect(swalvo.liveStreams).toBeDefined();
    expect(swalvo.live).toBeDefined();
  });

  it('exposes swalvo.live as the very same object as swalvo.liveStreams', () => {
    // An alias, not a second implementation: identity is the guarantee that
    // the two spellings can never drift apart.
    const swalvo = new Swalvo({ apiKey: 'k' });

    expect(swalvo.live).toBe(swalvo.liveStreams);
  });

  it('never exposes the API key through JSON.stringify or String() on the client itself', () => {
    const swalvo = new Swalvo({ apiKey: 'rvk_topsecret.value' });

    expect(JSON.stringify(swalvo)).not.toContain('topsecret');
    expect(String(swalvo)).not.toContain('topsecret');
  });

  it('does not automatically read process.env.SWALVO_API_KEY; apiKey must be passed explicitly', () => {
    const original = process.env.SWALVO_API_KEY;
    process.env.SWALVO_API_KEY = 'should-never-be-read-implicitly';
    try {
      // @ts-expect-error omitting the required field on purpose, to prove there's no implicit fallback
      expect(() => new Swalvo({})).toThrow(SwalvoError);
    } finally {
      process.env.SWALVO_API_KEY = original;
    }
  });
});
