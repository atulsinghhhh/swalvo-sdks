import { startBrowserLoginServer } from '../../src/lib/browser-login-server.js';

describe('startBrowserLoginServer', () => {
  it('listens on 127.0.0.1 and resolves a real, usable port', async () => {
    const { port, state, result } = startBrowserLoginServer();
    const actualPort = await port;
    expect(actualPort).toBeGreaterThan(0);

    // Clean up. A matching-state callback is what actually closes the
    // server and clears its 5-minute timeout. A mismatched state, tested
    // separately below, does neither, and would leave that timer running
    // for the rest of the file.
    await fetch(`http://127.0.0.1:${actualPort}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, token: 't', email: 'e@x.com' }),
    });
    await result;
  });

  it('resolves with the token/email once a matching-state callback is received', async () => {
    const { port, state, result } = startBrowserLoginServer();
    const actualPort = await port;

    await fetch(`http://127.0.0.1:${actualPort}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, token: 'real-jwt', email: 'dev@example.com' }),
    });

    await expect(result).resolves.toEqual({ token: 'real-jwt', email: 'dev@example.com' });
  });

  it('rejects (400) a callback whose state does not match, and keeps waiting', async () => {
    const { port, state, result } = startBrowserLoginServer();
    const actualPort = await port;

    const badResponse = await fetch(`http://127.0.0.1:${actualPort}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'wrong-state', token: 'stolen-token', email: 'attacker@evil.com' }),
    });
    expect(badResponse.status).toBe(400);

    // The real caller can still complete the flow afterwards.
    await fetch(`http://127.0.0.1:${actualPort}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, token: 'real-jwt', email: 'dev@example.com' }),
    });

    await expect(result).resolves.toEqual({ token: 'real-jwt', email: 'dev@example.com' });
  });

  it('sends permissive CORS headers so a real browser origin can POST to it', async () => {
    const { port, state, result } = startBrowserLoginServer();
    const actualPort = await port;

    const response = await fetch(`http://127.0.0.1:${actualPort}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, token: 't', email: 'e@x.com' }),
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    await result;
  });
});
