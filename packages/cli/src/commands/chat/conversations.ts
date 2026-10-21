import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerChatConversationsCommand(chat: Command): void {
  chat
    .command('conversations')
    .alias('list')
    .description("List a project's conversations with message counts and last activity")
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const conversations = await client.listChatConversations(projectId);

        if (opts.json) {
          printJson(conversations);
          return;
        }

        if (conversations.length === 0) {
          printEmpty(
            'No conversations yet.',
            'Conversations are created from your backend; a browser chat token cannot create them. Use swalvo.chat.createConversation() from @swalvo/server or swalvo-sdk.',
          );
          return;
        }

        printTable(conversations, [
          { header: 'NAME', value: (c) => c.name },
          { header: 'ID', value: (c) => c.id },
          { header: 'TYPE', value: (c) => (c.type === 'ROOM' ? 'rtc room' : c.type.toLowerCase()) },
          { header: 'STATUS', value: (c) => c.status.toLowerCase() },
          { header: 'MESSAGES', value: (c) => String(c.messageCount) },
          { header: 'MEMBERS', value: (c) => String(c.memberCount) },
          {
            header: 'LAST ACTIVITY',
            value: (c) => (c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : 'never'),
          },
        ]);

        // Stated instead of implied: this command shows activity, not
        // content, and there is no flag that would change that.
        process.stdout.write(
          '\nMessage contents are never returned to this surface; see docs/security/chat.md#privacy.\n',
        );
      }),
    );
}
