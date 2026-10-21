import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerRoomsListCommand(rooms: Command): void {
  rooms
    .command('list')
    .description("List a project's rooms, with live participant counts from the SFU")
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const list = await client.listRooms(projectId);

        if (opts.json) {
          printJson(list);
          return;
        }

        if (list.length === 0) {
          printEmpty('No rooms yet.', 'Run `swalvo rooms create <name>` to create one.');
          return;
        }

        printTable(list, [
          { header: 'ROOM', value: (r) => r.name },
          // null = SFU unreachable, shown as "unknown" rather than faking a 0
          {
            header: 'PARTICIPANTS',
            value: (r) => (r.liveParticipantCount === null ? 'unknown' : String(r.liveParticipantCount)),
          },
          { header: 'STATUS', value: (r) => roomStatusLabel(r.liveParticipantCount) },
          { header: 'CREATED', value: (r) => new Date(r.createdAt).toLocaleString() },
        ]);
      }),
    );
}

function roomStatusLabel(liveParticipantCount: number | null): string {
  if (liveParticipantCount === null) return 'unknown';
  return liveParticipantCount > 0 ? 'active' : 'idle';
}
