import { Command } from 'commander';
import { readEnv } from '../lib/env.js';
import open from 'open';
import chalk from 'chalk';
import { startBrowserLoginServer } from '../lib/browser-login-server.js';
import { TOKEN_ENV_VAR, writeCredentials } from '../lib/auth-store.js';
import { readCliConfig } from '../lib/cli-config.js';
import { decodeSessionToken } from '../lib/decode-token.js';
import { SwalvoApiClient } from '../lib/api-client.js';
import { printSuccess, printInfo } from '../lib/output.js';
import { withErrorHandling } from '../lib/run.js';
import { CliError } from '../lib/errors.js';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with Swalvo')
    .option('--no-open', 'print the login URL instead of opening a browser automatically')
    .option('--token <jwt>', 'authenticate with an existing session token instead of a browser (CI, containers, SSH)')
    .action(
      withErrorHandling(async (options: { open: boolean; token?: string }) => {
        const config = await readCliConfig();

        if (options.token) {
          await loginWithToken(options.token, config.apiUrl);
          return;
        }

        await loginWithBrowser(config.apiUrl, options.open);
      }),
    );
}

/**
 * Non-interactive login.
 *
 * We check the token against the API before anything touches disk. Writing
 * an unusable credential just moves the failure to the next command, where
 * the cause is far less obvious. `listProjects` is the probe because it's
 * the cheapest endpoint requiring a valid session; there's no /v1/auth/me
 * to ask instead.
 *
 * The token is never echoed back. Not even partially.
 */
async function loginWithToken(token: string, apiUrl: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new CliError('usage', '--token was empty.', {
      suggestion: 'Pass the session token itself, e.g. `swalvo login --token "$SWALVO_TOKEN"`',
    });
  }

  const client = new SwalvoApiClient(apiUrl, trimmed);
  try {
    await client.listProjects();
  } catch (error) {
    if (error instanceof CliError && error.kind === 'auth') {
      throw new CliError('auth', `${apiUrl} rejected that token.`, {
        suggestion:
          'Tokens expire; mint a fresh one from the dashboard, or run `swalvo login` on a machine with a browser',
        cause: error,
      });
    }
    throw error;
  }

  const email = decodeSessionToken(trimmed).email;

  await writeCredentials({
    token: trimmed,
    // Display only. The server decides who this token is.
    email: email ?? '(unknown)',
    apiUrl,
    createdAt: new Date().toISOString(),
  });

  printSuccess(email ? `Logged in as ${email}` : 'Logged in.');
  printInfo(`In an ephemeral environment, set ${TOKEN_ENV_VAR} instead; it needs no writable home directory.`);
}

async function loginWithBrowser(apiUrl: string, shouldOpen: boolean): Promise<void> {
  const { port, state, result } = startBrowserLoginServer();
  const localPort = await port;

  const loginUrl = new URL('/cli-auth', dashboardUrlFor(apiUrl));
  loginUrl.searchParams.set('port', String(localPort));
  loginUrl.searchParams.set('state', state);

  printSuccess(`Waiting for browser authentication…`);
  process.stdout.write(
    `\nIf your browser doesn't open automatically, visit:\n${chalk.cyan(loginUrl.toString())}\n\n` +
      `No browser here? Use ${chalk.cyan('swalvo login --token <jwt>')} or set ${chalk.cyan(TOKEN_ENV_VAR)}.\n\n`,
  );

  if (shouldOpen) {
    await open(loginUrl.toString()).catch(() => {
      // Non-fatal. The printed URL above is always the fallback.
    });
  }

  let outcome;
  try {
    outcome = await result;
  } catch (error) {
    throw error instanceof CliError ? error : new CliError('auth', 'Browser login failed.', { cause: error });
  }

  await writeCredentials({
    token: outcome.token,
    email: outcome.email,
    apiUrl,
    createdAt: new Date().toISOString(),
  });

  printSuccess(`Logged in as ${outcome.email}`);
}

/**
 * Dashboard origin, derived from the Control API URL. In local dev that's
 * API on :4100, dashboard on :3001. A hosted `api.<domain>` maps to
 * `app.<domain>`. Anything else, set SWALVO_DASHBOARD_URL explicitly.
 */
export function dashboardUrlFor(apiUrl: string): string {
  const override = readEnv('dashboardUrl');
  if (override) return override;
  try {
    const url = new URL(apiUrl);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return `${url.protocol}//${url.hostname}:3001`;
    }
    if (url.hostname.startsWith('api.')) {
      return `${url.protocol}//app.${url.hostname.slice('api.'.length)}`;
    }
  } catch {
    // fall through to the generic default below
  }
  return apiUrl;
}
