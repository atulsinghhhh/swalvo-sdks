import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { confirm } from '../../lib/prompt.js';
import { printInfo, printJson, printSuccess } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerKeysRevokeCommand(keys: Command): void {
  keys
    .command('revoke <keyId>')
    .description('Revoke an API key; immediate and permanent')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (keyId: string, opts: { project?: string; yes?: boolean; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();

        const confirmed = await confirm(`Revoke key ${keyId}? This cannot be undone.`, { assumeYes: opts.yes });
        if (!confirmed) {
          printInfo('Cancelled.');
          return;
        }

        await client.revokeApiKey(projectId, keyId);

        if (opts.json) {
          printJson({ revoked: true, id: keyId });
          return;
        }
        printSuccess('Key revoked.');
      }),
    );
}
