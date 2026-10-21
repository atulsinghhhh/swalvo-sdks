import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printField, printJson, printSuccess } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerRoomsCreateCommand(rooms: Command): void {
  rooms
    .command('create <name>')
    .description('Create a room in a project')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (name: string, opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const room = await client.createRoom(projectId, name);

        if (opts.json) {
          printJson(room);
          return;
        }

        printSuccess('Room created');
        process.stdout.write('\n');
        printField('Room', room.name);
        printField('ID', room.id);
      }),
    );
}
