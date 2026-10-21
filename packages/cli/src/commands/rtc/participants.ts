import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerRtcParticipantsCommand(rtc: Command): void {
  const participants = rtc.command('participants').description('Participants connected to a live room');

  participants
    .command('list <room>')
    .description('List everyone currently connected to a room, with their tracks')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (roomId: string, opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const room = await client.getRoom(projectId, roomId);

        if (opts.json) {
          printJson(room.liveParticipants);
          return;
        }

        if (room.liveParticipants === null) {
          printEmpty(
            'Live state is unavailable; the RTC server could not be reached.',
            'Check: swalvo rtc servers list',
          );
          return;
        }
        if (room.liveParticipants.length === 0) {
          printEmpty(`Nobody is connected to "${room.name}" right now.`);
          return;
        }

        printTable(room.liveParticipants, [
          { header: 'Identity', value: (participant) => participant.identity },
          { header: 'Joined', value: (participant) => new Date(participant.joinedAt).toLocaleTimeString() },
          {
            header: 'Tracks',
            value: (participant) =>
              participant.tracks.length === 0
                ? chalk.dim('none')
                : participant.tracks.map((track) => `${track.name}${track.muted ? '*' : ''}`).join(' '),
          },
        ]);

        if (room.liveParticipants.some((participant) => participant.tracks.some((track) => track.muted))) {
          process.stdout.write(`\n${chalk.dim('* muted')}\n`);
        }
      }),
    );
}
