import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';
import type { ErrorCategory } from '../../lib/types.js';

export function registerErrorsListCommand(errors: Command): void {
  errors
    .command('list')
    .description("List a project's classified RTC errors")
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('-c, --category <category>', 'filter by category, e.g. TOKEN_ERROR, ICE_ERROR, TURN_ERROR')
    .option('--connection <connectionId>', 'filter to one connection')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(
        async (opts: { project?: string; category?: ErrorCategory; connection?: string; json?: boolean }) => {
          const projectId = await resolveProjectId(opts.project);
          const { client } = await getAuthenticatedApiClient();
          const list = await client.listErrors(projectId, { category: opts.category, connectionId: opts.connection });

          if (opts.json) {
            printJson(list);
            return;
          }

          if (list.length === 0) {
            printEmpty('No errors recorded.', 'Good sign; or no connections have been made yet.');
            return;
          }

          printTable(list, [
            { header: 'ERROR', value: (e) => e.publicId },
            { header: 'CATEGORY', value: (e) => e.category },
            { header: 'MESSAGE', value: (e) => truncate(e.message, 50) },
            { header: 'CONNECTION', value: (e) => e.connectionId ?? '—' },
            { header: 'WHEN', value: (e) => new Date(e.timestamp).toLocaleString() },
          ]);
        },
      ),
    );
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
