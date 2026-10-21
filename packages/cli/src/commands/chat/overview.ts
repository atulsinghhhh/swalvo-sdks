import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printField, printJson } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

const RANGES = ['15m', '1h', '24h', '7d'];

export function registerChatOverviewCommand(chat: Command): void {
  chat
    .command('overview')
    .description('Chat activity for the current project; real counters, never estimates')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('-r, --range <range>', `time window (${RANGES.join(', ')})`, '1h')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; range?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        // Anything else quietly resolves to 1h server-side, and then you're
        // printing numbers that don't match the label.
        const range = RANGES.includes(opts.range ?? '') ? opts.range : '1h';

        const { client } = await getAuthenticatedApiClient();
        const overview = await client.getChatOverview(projectId, range);

        if (opts.json) {
          printJson(overview);
          return;
        }

        printField('Range', overview.range);
        printField('Conversations', String(overview.conversations));
        printField('Messages stored', String(overview.messagesStored));
        printField('Live connections', String(overview.activeConnections));

        process.stdout.write('\n');
        printField('Messages sent', String(overview.messagesSent));
        printField('Messages failed', String(overview.messagesFailed));
        printField('Fan-out deliveries', String(overview.messagesFannedOut));
        printField('Rate limited', String(overview.rateLimited));
        printField('Messages / second', overview.messagesPerSecond.toFixed(2));

        process.stdout.write('\n');
        // null means nothing got measured in this window. Print "0 ms" and
        // you're claiming a measurement nobody took.
        printField('Storage latency', formatLatency(overview.latency.persistMs));
        printField('Fan-out latency', formatLatency(overview.latency.fanoutMs));
        printField('End-to-end latency', formatLatency(overview.latency.endToEndMs));

        process.stdout.write('\n');
        printField('Gateway', overview.gateway.gatewayId);
        printField('Sockets held', String(overview.gateway.activeConnections));
        printField('Rooms subscribed', String(overview.gateway.subscribedRooms));

        // The overview reflects whichever gateway served this request. In a
        // fleet that's one instance out of several, and saying so stops
        // anyone reading it as a cluster-wide total.
        process.stdout.write('\nGateway figures are for the instance that served this request, not the whole fleet.\n');
      }),
    );
}

function formatLatency(value: number | null): string {
  return value === null ? 'not measured in this window' : `${value} ms`;
}
