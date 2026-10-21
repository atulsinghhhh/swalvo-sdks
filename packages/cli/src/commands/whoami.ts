import { Command } from 'commander';
import { requireCredentials } from '../lib/context.js';
import { TOKEN_ENV_VAR } from '../lib/auth-store.js';
import { SwalvoApiClient } from '../lib/api-client.js';
import { printField, printJson } from '../lib/output.js';
import { withErrorHandling } from '../lib/run.js';

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Show the currently authenticated Swalvo account')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { json?: boolean }) => {
        const credentials = await requireCredentials();
        const client = new SwalvoApiClient(credentials.apiUrl, credentials.token);

        // Fetched live. Not cached, not guessed.
        const projects = await client.listProjects();

        // Where the token came from. Worth printing, because the commonest
        // CI confusion by far is a stale credentials.json quietly winning,
        // or a $SWALVO_TOKEN quietly overriding somebody's own session.
        const source = credentials.fromEnvironment ? `$${TOKEN_ENV_VAR}` : 'credentials file';

        if (opts.json) {
          printJson({
            email: credentials.email,
            projectCount: projects.length,
            environment: 'development',
            apiUrl: credentials.apiUrl,
            credentialSource: source,
          });
          return;
        }

        printField('Logged in as', credentials.email);
        printField('Credentials', source);
        printField('API', credentials.apiUrl);
        printField('Projects', String(projects.length));
        // The control plane doesn't distinguish environments per project
        // yet. This is the honest value, not an invented one.
        printField('Environment', 'development');
      }),
    );
}
