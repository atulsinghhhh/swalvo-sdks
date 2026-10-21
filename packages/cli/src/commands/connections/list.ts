import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';
import type { ConnectionLifecycleState } from '../../lib/types.js';

export function registerConnectionsListCommand(connections: Command): void {
  connections
    .command('list')
    .description("List a project's real RTC connections")
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('-r, --room <roomId>', 'filter to one room')
    .option('-s, --state <state>', 'filter by state: CONNECTING, CONNECTED, RECONNECTING, DISCONNECTED, FAILED')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(
        async (opts: { project?: string; room?: string; state?: ConnectionLifecycleState; json?: boolean }) => {
          const projectId = await resolveProjectId(opts.project);
          const { client } = await getAuthenticatedApiClient();
          const list = await client.listConnections(projectId, { roomId: opts.room, state: opts.state });

          if (opts.json) {
            printJson(list);
            return;
          }

          if (list.length === 0) {
            printEmpty('No connections yet.', 'They appear here once a real client joins a room via @swalvo/rtc.');
            return;
          }

          printTable(list, [
            { header: 'CONNECTION', value: (c) => c.publicId },
            { header: 'ROOM', value: (c) => c.roomName },
            { header: 'PARTICIPANT', value: (c) => c.participantIdentity },
            { header: 'STATE', value: (c) => c.state },
            { header: 'QUALITY', value: (c) => c.connectionQuality ?? '—' },
            { header: 'RECONNECTS', value: (c) => String(c.reconnectCount) },
            { header: 'DURATION', value: (c) => formatDuration(c.durationMs) },
            { header: 'STARTED', value: (c) => new Date(c.startedAt).toLocaleString() },
          ]);
        },
      ),
    );
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
