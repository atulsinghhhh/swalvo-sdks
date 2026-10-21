import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerProjectsListCommand(projects: Command): void {
  projects
    .command('list')
    .description('List your Swalvo projects')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { json?: boolean }) => {
        const { client } = await getAuthenticatedApiClient();
        const list = await client.listProjects();

        if (opts.json) {
          printJson(list);
          return;
        }

        if (list.length === 0) {
          printEmpty('No projects yet.', 'Run `swalvo projects create <name>` to create one.');
          return;
        }

        printTable(list, [
          { header: 'NAME', value: (p) => p.name },
          { header: 'ID', value: (p) => p.id },
          // Fixed label. No per-project environments in the control plane
          // yet.
          { header: 'ENV', value: () => 'development' },
        ]);
      }),
    );
}
