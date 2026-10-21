import { SwalvoAdapter, RavenAdapter } from '../src/internal/sfu/swalvo-adapter';

describe('legacy Raven* aliases', () => {
  it('RavenAdapter is the same class as SwalvoAdapter', () => {
    expect(RavenAdapter).toBe(SwalvoAdapter);
  });
});
