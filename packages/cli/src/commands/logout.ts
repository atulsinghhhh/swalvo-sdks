import { Command } from 'commander';
import { clearCredentials, hasEnvToken, readCredentials, TOKEN_ENV_VAR } from '../lib/auth-store.js';
import { SwalvoApiClient } from '../lib/api-client.js';
import { printSuccess, printInfo } from '../lib/output.js';
import { withErrorHandling } from '../lib/run.js';

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Sign out and remove locally stored Swalvo credentials')
    .action(
      withErrorHandling(async () => {
        const credentials = await readCredentials();
        const envToken = hasEnvToken();

        if (!credentials) {
          // Saying "logged out" while $SWALVO_TOKEN is still set would be a
          // lie. The next command would authenticate perfectly well.
          printInfo(
            envToken
              ? `No stored credentials to remove, but $${TOKEN_ENV_VAR} is set; unset it to sign out of this shell.`
              : 'Already logged out.',
          );
          return;
        }

        // Best-effort server-side blocklist. Local creds get cleared
        // either way, so "logged out" never waits on the network.
        await new SwalvoApiClient(credentials.apiUrl, credentials.token).logout().catch(() => undefined);

        await clearCredentials();
        printSuccess('Logged out.');

        if (envToken) {
          printInfo(`$${TOKEN_ENV_VAR} is still set and takes precedence; unset it to finish signing out.`);
        }
      }),
    );
}
