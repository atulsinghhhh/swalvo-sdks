import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';
import type { LiveStreamStatus } from '../../lib/types.js';

export function registerStreamsListCommand(streams: Command): void {
  streams
    .command('list')
    .description("List a project's live streams")
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('-s, --status <status>', 'filter by status: CREATED | LIVE | ENDED')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; status?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const list = await client.listStreams(projectId, opts.status as LiveStreamStatus | undefined);

        if (opts.json) {
          printJson(list);
          return;
        }

        if (list.length === 0) {
          printEmpty('No live streams yet.', 'Run `swalvo streams create` to create one.');
          return;
        }

        printTable(list, [
          { header: 'ID', value: (s) => s.id },
          { header: 'TITLE', value: (s) => s.title },
          { header: 'STATUS', value: (s) => s.status },
          { header: 'HOSTS', value: (s) => String(s.hosts.length) },
          { header: 'CREATED', value: (s) => new Date(s.createdAt).toLocaleString() },
        ]);
      }),
    );
}
