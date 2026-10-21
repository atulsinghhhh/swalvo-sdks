import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerChatPresenceCommand(chat: Command): void {
  chat
    .command('presence <conversation>')
    .description('Show who is present in a conversation right now')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (conversation: string, opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const present = await client.getChatPresence(projectId, conversation);

        if (opts.json) {
          printJson(present);
          return;
        }

        if (present.length === 0) {
          printEmpty(
            'Nobody is present.',
            'Presence is ephemeral and expires ~45s after a client stops responding; an empty list here is a real answer, not a missing record.',
          );
          return;
        }

        printTable(present, [
          { header: 'USER', value: (entry) => entry.userId },
          { header: 'STATUS', value: (entry) => entry.status },
        ]);

        // Worth saying, because a stale-looking entry is usually correct:
        // presence is TTL'd in Redis, never written to Postgres.
        process.stdout.write('\nPresence is read from Redis and expires on its own; it is never stored durably.\n');
      }),
    );
}
