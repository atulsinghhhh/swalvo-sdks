import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';
import type { ConnectionLifecycleState } from '../../lib/types.js';

const STATES: ConnectionLifecycleState[] = ['CONNECTED', 'CONNECTING', 'RECONNECTING', 'DISCONNECTED', 'FAILED'];

export function registerChatConnectionsCommand(chat: Command): void {
  chat
    .command('connections')
    .description('List chat WebSocket sessions, newest first')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('-s, --state <state>', `filter by state (${STATES.join(', ')})`)
    .option('-l, --limit <limit>', 'maximum records to fetch (max 200)', '50')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; state?: string; limit?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const state = (STATES as string[]).includes(opts.state ?? '')
          ? (opts.state as ConnectionLifecycleState)
          : undefined;

        const { client } = await getAuthenticatedApiClient();
        const connections = await client.listChatConnections(projectId, {
          state,
          limit: Number(opts.limit) || 50,
        });

        if (opts.json) {
          printJson(connections);
          return;
        }

        if (connections.length === 0) {
          printEmpty(
            'No chat connections recorded.',
            'A record appears the moment a client calls connect() with @swalvo/chat.',
          );
          return;
        }

        printTable(connections, [
          { header: 'CONNECTION', value: (c) => c.publicId },
          { header: 'USER', value: (c) => c.userId },
          { header: 'STATE', value: (c) => c.state.toLowerCase() },
          // The column you need when one instance in a fleet misbehaves.
          { header: 'GATEWAY', value: (c) => c.gatewayId },
          { header: 'MESSAGES', value: (c) => String(c.messagesSent) },
          { header: 'DURATION', value: (c) => formatDuration(c.durationMs) },
          { header: 'STARTED', value: (c) => new Date(c.createdAt).toLocaleString() },
        ]);

        const gateways = new Set(connections.map((c) => c.gatewayId));
        if (gateways.size > 1) {
          process.stdout.write(`\nSpread across ${gateways.size} gateway instances.\n`);
        }
      }),
    );
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return 'live';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
