import { credentialsFromEnv, readCredentials, type StoredCredentials } from './auth-store.js';
import { readCliConfig } from './cli-config.js';
import { SwalvoApiClient } from './api-client.js';
import { notLoggedInError } from './errors.js';

/** An unauthenticated client, for `login`, `register` and `status`'s public /health call. */
export async function getPublicApiClient(): Promise<SwalvoApiClient> {
  const config = await readCliConfig();
  return new SwalvoApiClient(config.apiUrl);
}

/**
 * Throws notLoggedInError() when there's nothing to work with. Every command
 * needing a user goes through here instead of duplicating the check.
 *
 * $SWALVO_TOKEN beats the credentials file. That ordering is what makes the
 * CLI usable in CI, in a container, or over SSH, all places where
 * `swalvo login` has no browser to open. It also lets someone run a single
 * command as a service account without disturbing their own stored session.
 */
export async function requireCredentials(): Promise<StoredCredentials> {
  const config = await readCliConfig();

  const fromEnv = credentialsFromEnv(config.apiUrl);
  if (fromEnv) return fromEnv;

  const credentials = await readCredentials();
  if (!credentials) throw notLoggedInError();
  return credentials;
}

export async function getAuthenticatedApiClient(): Promise<{
  client: SwalvoApiClient;
  credentials: StoredCredentials;
}> {
  const credentials = await requireCredentials();
  return { client: new SwalvoApiClient(credentials.apiUrl, credentials.token), credentials };
}
