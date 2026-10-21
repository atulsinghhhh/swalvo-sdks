import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerRoomsInspectCommand(rooms: Command): void {
  rooms
    .command('inspect <room>')
    .description('Show live participants and published tracks for a room')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (roomId: string, opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const room = await client.getRoom(projectId, roomId);

        if (opts.json) {
          printJson(room);
          return;
        }

        process.stdout.write(`${chalk.bold(`Room: ${room.name}`)}\n\n`);

        if (room.liveParticipants === null) {
          printEmpty('Live participant data is unavailable; the SFU could not be reached.');
          return;
        }

        if (room.liveParticipants.length === 0) {
          printEmpty('No one is connected right now.');
          return;
        }

        process.stdout.write(`${chalk.dim('Participants:')}\n\n`);
        for (const participant of room.liveParticipants) {
          process.stdout.write(`${participant.identity}\n`);
          if (participant.tracks.length === 0) {
            process.stdout.write(`  ${chalk.dim('(no published tracks)')}\n`);
          }
          for (const track of participant.tracks) {
            process.stdout.write(`  ${track.kind}${track.muted ? chalk.dim(' (muted)') : ''}\n`);
          }
          process.stdout.write(`  ${chalk.dim('connected')}\n\n`);
        }
      }),
    );
}
