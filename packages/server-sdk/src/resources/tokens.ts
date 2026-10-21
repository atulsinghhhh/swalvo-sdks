import type { SwalvoHttpClient } from '../http-client';
import type { CreateTokenParams, IssuedToken } from '../types';

/**
 * The heart of this SDK (Phase 10 spec §15). Mint a short-lived RTC token
 * server-side, then hand it to your frontend.
 *
 * Never mint a token in the browser, and never hold on to a minted one any
 * longer than it takes to forward it. Every token is short-lived by design,
 * and there's no way to ask for a permanent one (see `expiresIn`).
 */
export class TokensResource {
  constructor(private readonly http: SwalvoHttpClient) {}

  create(params: CreateTokenParams): Promise<IssuedToken> {
    const { room, identity, permissions, expiresIn, metadata, attributes } = params;
    return this.http.request<IssuedToken>(`/v1/rooms/${room}/rtc-tokens`, {
      method: 'POST',
      body: {
        participantIdentity: identity,
        permissions,
        ttlSeconds: expiresIn,
        metadata,
        attributes,
      },
    });
  }
}
