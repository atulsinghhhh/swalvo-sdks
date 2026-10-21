import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printJson, printSuccess } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';
import { CliError } from '../../lib/errors.js';
import type { Environment } from '../../lib/types.js';

export function registerKeysCreateCommand(keys: Command): void {
  keys
    .command('create')
    .description('Create a new API key for a project; the secret is shown exactly once')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('-n, --name <name>', 'a label for the key')
    .option('-e, --environment <environment>', 'development | staging | production (default: development)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; name?: string; environment?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const environment = parseEnvironment(opts.environment);
        const { client } = await getAuthenticatedApiClient();
        const created = await client.createApiKey(projectId, { name: opts.name, environment });

        if (opts.json) {
          printJson(created);
          return;
        }

        // Defensive. An older API from before environments returns no such
        // field, and crashing here would burn the developer's one and only
        // chance to copy their secret.
        const created_env = created.environment ?? 'DEVELOPMENT';
        printSuccess(`API key created for the ${created_env.toLowerCase()} environment.`);
        process.stdout.write(`\n${chalk.yellow('Save this key now. It will not be shown again.')}\n\n`);
        process.stdout.write(`${chalk.bold(created.key)}\n`);

        if (created_env === 'PRODUCTION') {
          // Worth one line of friction. A production key in a browser
          // bundle, or a committed .env, is the mistake that actually
          // hurts.
          process.stdout.write(
            `\n${chalk.dim('This is a production key. Keep it server-side; never in an app bundle or a committed file.')}\n`,
          );
        }
      }),
    );
}

/**
 * Takes `prod`, `production`, `PRODUCTION` and the rest, because demanding
 * an exact enum spelling from a CLI is a papercut.
 *
 * An unrecognised value gets refused, not quietly defaulting.
 * Silently handing a development key to someone who typed
 * `--environment prd` is the genuinely confusing outcome.
 */
function parseEnvironment(value?: string): Environment | undefined {
  if (!value) return undefined;

  const normalised = value.trim().toLowerCase();
  const match: Record<string, Environment> = {
    dev: 'DEVELOPMENT',
    development: 'DEVELOPMENT',
    stg: 'STAGING',
    staging: 'STAGING',
    prod: 'PRODUCTION',
    production: 'PRODUCTION',
  };

  const resolved = match[normalised];
  if (!resolved) {
    throw new CliError('usage', `Unknown environment "${value}".`, {
      suggestion: 'Use one of: development, staging, production.',
    });
  }
  return resolved;
}
