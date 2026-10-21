import { Command } from 'commander';
import { registerChatOverviewCommand } from './overview.js';
import { registerChatConversationsCommand } from './conversations.js';
import { registerChatConnectionsCommand } from './connections.js';
import { registerChatPresenceCommand } from './presence.js';

/**
 * `swalvo chat`. Inspection only, and that's deliberate.
 *
 * The CLI authenticates with a developer's session, the same JWT the
 * dashboard uses, and every command in here reads a dashboard-facing
 * endpoint. Sending a message or minting a chat token needs a *project API
 * key*, which is a runtime credential your backend holds. Not something the
 * CLI should store, or encourage anyone to paste into a terminal.
 *
 * Which is why there's no `swalvo chat send`. Use `@swalvo/server` or
 * `swalvo-sdk` from your backend for that. See docs/cli.md#chat.
 */
export function registerChatCommand(program: Command): void {
  const chat = program.command('chat').description("Inspect a project's chat activity, conversations, and connections");

  registerChatOverviewCommand(chat);
  registerChatConversationsCommand(chat);
  registerChatConnectionsCommand(chat);
  registerChatPresenceCommand(chat);
}
