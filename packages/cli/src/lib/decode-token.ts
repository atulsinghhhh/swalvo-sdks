/**
 * Reads claims out of a session JWT, for display only.
 *
 * Nothing checks the signature here, and nothing this returns feeds an
 * authorization decision; the Control API verifies the token on every
 * request. It exists so `swalvo login --token` and `swalvo whoami` can show
 * *which* account a token belongs to without a round trip.
 */
export interface DecodedSessionToken {
  email?: string;
  /** `exp` in milliseconds, to match Date, rather than the seconds JWTs use. */
  expiresAtMs?: number;
}

export function decodeSessionToken(token: string): DecodedSessionToken {
  try {
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return {};

    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;

    return {
      email: typeof claims.email === 'string' ? claims.email : undefined,
      expiresAtMs: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined,
    };
  } catch {
    // A token we can't parse may still be one the server accepts; its
    // opinion is the one that counts. So this isn't an error. The caller
    // just gets nothing to display.
    return {};
  }
}
