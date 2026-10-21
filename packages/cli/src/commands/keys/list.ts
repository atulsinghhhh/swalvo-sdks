import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerKeysListCommand(keys: Command): void {
  keys
    .command('list')
    .description("List a project's API keys (secrets are never shown again after creation)")
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const list = await client.listApiKeys(projectId);

        if (opts.json) {
          printJson(list);
          return;
        }

        if (list.length === 0) {
          printEmpty('No API keys yet.', 'Run `swalvo keys create` to create one.');
          return;
        }

        printTable(list, [
          { header: 'NAME', value: (k) => k.name ?? '(unnamed)' },
          { header: 'PUBLIC ID', value: (k) => k.publicId },
          { header: 'ENVIRONMENT', value: (k) => (k.environment ?? 'DEVELOPMENT').toLowerCase() },
          { header: 'STATUS', value: (k) => k.status },
          { header: 'LAST USED', value: (k) => (k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'never') },
        ]);
      }),
    );
}
