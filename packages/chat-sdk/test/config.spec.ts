import { createChatClient } from '../src/client';
import { validateConfig } from '../src/config';
import { SwalvoChatAuthenticationError } from '../src/errors';
import { fakeToken } from './helpers/token';

/**
 * Endpoint resolution is the developer-facing half of Swalvo's URL model: an
 * application forwards the mint response and never composes a WebSocket
 * address itself. These tests pin that contract from the outside, because
 * every one of them is a shape somebody will actually pass.
 */
describe('chat endpoint resolution', () => {
  it('accepts a whole chat grant verbatim', () => {
    // Exactly what POST /v1/chat/tokens returns, forwarded untouched.
    const grant = {
      token: fakeToken(),
      tokenId: 'ctk_1',
      userId: 'alice',
      projectId: 'project_1',
      scopes: ['chat:read', 'chat:send'],
      conversations: ['conv_1'],
      chatUrl: 'wss://api.swalvo.com/v1/chat/ws',
      apiUrl: 'https://api.swalvo.com',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };

    expect(() => createChatClient(grant)).not.toThrow();
  });

  it('derives the WebSocket URL from apiUrl alone', () => {
    const resolved = validateConfig({ token: fakeToken(), apiUrl: 'https://api.swalvo.com' });

    expect(resolved.chatUrl).toBe('wss://api.swalvo.com/v1/chat/ws');
    expect(resolved.apiUrl).toBe('https://api.swalvo.com');
  });

  it('derives the REST base from chatUrl alone, so history keeps working', () => {
    const resolved = validateConfig({ token: fakeToken(), chatUrl: 'wss://api.swalvo.com/v1/chat/ws' });

    expect(resolved.apiUrl).toBe('https://api.swalvo.com');
  });

  it('maps http to ws for a local control plane, so the same code works unhosted', () => {
    // §8 of the URL model: local development must not need different
    // application code, only a different SWALVO_API_URL on the backend.
    const resolved = validateConfig({ token: fakeToken(), apiUrl: 'http://localhost:4100' });

    expect(resolved.chatUrl).toBe('ws://localhost:4100/v1/chat/ws');
  });

  it('tolerates a trailing slash on apiUrl rather than producing a double slash', () => {
    const resolved = validateConfig({ token: fakeToken(), apiUrl: 'https://api.swalvo.com/' });

    expect(resolved.chatUrl).toBe('wss://api.swalvo.com/v1/chat/ws');
  });

  it('rejects a token with no address alongside it, naming both fields that would fix it', () => {
    // A chat token carries sub/pid/cvs/scopes/exp/jti and no address, so
    // there is genuinely nothing to derive from. The error has to say which
    // fields satisfy it; "chatUrl is required" alone sent people looking
    // for a field the grant calls apiUrl.
    let caught: Error | undefined;
    try {
      validateConfig({ token: fakeToken() });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(SwalvoChatAuthenticationError);
    expect(caught?.message).toContain('chatUrl');
    expect(caught?.message).toContain('apiUrl');
  });

  it('rejects an already-expired token before any socket is opened', () => {
    const expired = fakeToken({ exp: Math.floor(Date.now() / 1000) - 60 });

    expect(() => validateConfig({ token: expired })).toThrow(SwalvoChatAuthenticationError);
  });

  it('rejects a malformed token', () => {
    expect(() => validateConfig({ token: 'not-a-jwt', apiUrl: 'https://api.swalvo.com' })).toThrow(
      SwalvoChatAuthenticationError,
    );
  });
});
