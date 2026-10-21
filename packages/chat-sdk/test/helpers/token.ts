/** Builds a syntactically valid chat token. Nothing checks the signature client-side. */
export function fakeToken(overrides: Record<string, unknown> = {}): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      jti: 'ctk_test',
      sub: 'alice',
      pid: 'project_1',
      cvs: [],
      scopes: ['chat:read', 'chat:send'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: 'raven-chat',
      iss: 'raven',
      ...overrides,
    }),
  );
  return `${header}.${payload}.signature`;
}
