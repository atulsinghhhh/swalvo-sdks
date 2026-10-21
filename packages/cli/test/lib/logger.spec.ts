import { redact } from '../../src/lib/logger.js';

describe('redact', () => {
  it('redacts common secret-shaped keys regardless of case', () => {
    const input = { Token: 'jwt-value', SECRET: 'abc', Password: 'hunter2', apiKey: 'not-matched-key-name-itself' };
    const output = redact(input) as Record<string, unknown>;

    expect(output.Token).toBe('[redacted]');
    expect(output.SECRET).toBe('[redacted]');
    expect(output.Password).toBe('[redacted]');
  });

  it('redacts a literal "key" field but leaves unrelated fields alone', () => {
    const output = redact({ key: 'rvk_abc.secret', name: 'my-key' }) as Record<string, unknown>;
    expect(output.key).toBe('[redacted]');
    expect(output.name).toBe('my-key');
  });

  it('redacts an "authorization" field (header-shaped payloads)', () => {
    const output = redact({ authorization: 'Bearer abc.def.ghi' }) as Record<string, unknown>;
    expect(output.authorization).toBe('[redacted]');
  });

  it('recurses into nested objects and arrays', () => {
    const output = redact({ body: { credential: 'shh', nested: [{ token: 'x' }] } }) as any;
    expect(output.body.credential).toBe('[redacted]');
    expect(output.body.nested[0].token).toBe('[redacted]');
  });

  it('leaves non-sensitive primitive values untouched', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });
});
