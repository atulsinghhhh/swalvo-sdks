import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printField, printJson, printSuccess, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

interface ProjectOpts {
  project?: string;
  json?: boolean;
}

export function registerRtcRoomsCommand(rtc: Command): void {
  const rooms = rtc.command('rooms').description('Rooms as the media plane sees them');

  rooms
    .command('list')
    .description('List rooms with their live participant counts')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: ProjectOpts) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const rows = await client.listRooms(projectId);

        if (opts.json) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          printEmpty('No rooms in this project yet.', 'Create one with: swalvo rooms create <name>');
          return;
        }

        printTable(rows, [
          { header: 'Room', value: (room) => room.name },
          { header: 'Status', value: (room) => room.status },
          // "unknown", not "0". A room whose server couldn't be reached is
          // not the same as an empty one, and printing 0 tells an operator
          // every call has ended.
          {
            header: 'Live',
            value: (room) =>
              room.liveParticipantCount === null ? chalk.dim('unknown') : String(room.liveParticipantCount),
          },
          { header: 'ID', value: (room) => room.id },
        ]);
      }),
    );

  rooms
    .command('get <room>')
    .description('Show one room with its live participants and published tracks')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (roomId: string, opts: ProjectOpts) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const room = await client.getRoom(projectId, roomId);

        if (opts.json) {
          printJson(room);
          return;
        }

        process.stdout.write(`${chalk.bold(`Room: ${room.name}`)}\n\n`);
        printField('ID', room.id);
        printField('Status', room.status);
        printField('Created', new Date(room.createdAt).toLocaleString());

        if (room.liveParticipants === null) {
          process.stdout.write('\n');
          printEmpty(
            'Live state is unavailable; the RTC server could not be reached.',
            'The room may still be running. Check: swalvo rtc servers list',
          );
          return;
        }

        printField('Live participants', String(room.liveParticipants.length));

        if (room.liveParticipants.length === 0) {
          process.stdout.write('\n');
          printEmpty('Nobody is connected right now.');
          return;
        }

        process.stdout.write(`\n${chalk.dim('Participants:')}\n\n`);
        for (const participant of room.liveParticipants) {
          const tracks =
            participant.tracks.length === 0
              ? chalk.dim('no tracks')
              : participant.tracks
                  .map((track) => `${track.name}${track.muted ? chalk.dim(' (muted)') : ''}`)
                  .join(', ');
          process.stdout.write(`  ${chalk.bold(participant.identity)}  ${tracks}\n`);
        }
      }),
    );

  rooms
    .command('close <room>')
    .description('Close a room in the control plane')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (roomId: string, opts: ProjectOpts) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        await client.closeRoom(projectId, roomId);

        if (opts.json) {
          printJson({ id: roomId, status: 'CLOSED' });
          return;
        }

        printSuccess('Room closed');
        // Worth spelling out. Closing marks the control-plane record so no
        // new token can be minted for it. Anyone already connected stays
        // connected until they leave; the alternative is cutting off a live
        // call from a CLI command.
        process.stdout.write(
          `\n${chalk.dim('No new tokens can be minted for this room. Participants already connected are not disconnected.')}\n`,
        );
      }),
    );
}
