import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { printEmpty, printField, printJson, printSuccess, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';
import type { RtcServer } from '../../lib/types.js';

/**
 * Renders a percentage the node may never have measured.
 *
 * A node that's registered but not yet heartbeated reports `null`, and
 * printing `0%` there reads as "idle" instead of "not known yet". That's
 * exactly the distinction an operator deciding whether to scale needs.
 */
function percent(value: number | null): string {
  return value === null ? chalk.dim('—') : `${value.toFixed(0)}%`;
}

function bitrate(value: number | null): string {
  if (value === null) return chalk.dim('—');
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)} kbps`;
  return `${value.toFixed(0)} bps`;
}

function statusLabel(status: RtcServer['status']): string {
  switch (status) {
    case 'HEALTHY':
      return chalk.green('healthy');
    case 'DRAINING':
      return chalk.yellow('draining');
    case 'UNHEALTHY':
      return chalk.red('unhealthy');
  }
}

/**
 * How stale a heartbeat is, in words.
 *
 * Every load figure a node reports is a snapshot from its last heartbeat, so
 * showing the age next to them is what keeps the numbers honest.
 */
function heartbeatAge(lastHeartbeatAt: string | null): string {
  if (!lastHeartbeatAt) return chalk.dim('never');
  const seconds = Math.round((Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function registerRtcServersCommand(rtc: Command): void {
  const servers = rtc.command('servers').description('The RTC server fleet');

  servers
    .command('list')
    .description('List RTC servers with their health and load')
    .option('--region <region>', 'only show servers in one region')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { region?: string; json?: boolean }) => {
        const { client } = await getAuthenticatedApiClient();
        const [fleet, rows] = await Promise.all([client.getRtcFleetMetrics(), client.listRtcServers(opts.region)]);

        if (opts.json) {
          printJson({ fleet, servers: rows });
          return;
        }

        if (rows.length === 0) {
          printEmpty(
            opts.region ? `No RTC servers registered in region "${opts.region}".` : 'No RTC servers are registered.',
            'Servers register themselves on boot; check that one is running and can reach the API.',
          );
          return;
        }

        printTable(rows, [
          { header: 'Server', value: (server) => server.name },
          { header: 'Region', value: (server) => server.region },
          { header: 'Status', value: (server) => statusLabel(server.status) },
          { header: 'Rooms', value: (server) => `${server.activeRooms}/${server.capacity}` },
          { header: 'Participants', value: (server) => String(server.activeParticipants) },
          { header: 'CPU', value: (server) => percent(server.cpuPercent) },
          { header: 'Heartbeat', value: (server) => heartbeatAge(server.lastHeartbeatAt) },
        ]);

        process.stdout.write(
          `\n${chalk.dim(
            `${fleet.healthyServers} healthy, ${fleet.drainingServers} draining, ${fleet.unhealthyServers} unhealthy · ` +
              `${fleet.activeRooms}/${fleet.capacity} rooms · ${fleet.activeParticipants} participants`,
          )}\n`,
        );
        process.stdout.write(`${chalk.dim("Load figures are each node's last heartbeat, not live truth.")}\n`);
      }),
    );

  servers
    .command('get <server>')
    .description('Show one RTC server in detail')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (name: string, opts: { json?: boolean }) => {
        const { client } = await getAuthenticatedApiClient();
        const server = await client.getRtcServer(name);

        if (opts.json) {
          printJson(server);
          return;
        }

        process.stdout.write(`${chalk.bold(`RTC server: ${server.name}`)}\n\n`);
        printField('Region', server.region);
        printField('Status', statusLabel(server.status));
        printField('Version', server.version ?? '—');
        printField('Public host', server.publicHost);
        printField('Rooms', `${server.activeRooms} / ${server.capacity}`);
        printField('Participants', String(server.activeParticipants));
        printField('CPU', percent(server.cpuPercent));
        printField('Memory', percent(server.memoryPercent));
        printField('Network in', bitrate(server.networkInBps));
        printField('Network out', bitrate(server.networkOutBps));
        printField('Last heartbeat', heartbeatAge(server.lastHeartbeatAt));
        printField('Registered', new Date(server.registeredAt).toLocaleString());

        if (server.status === 'UNHEALTHY') {
          process.stdout.write(
            `\n${chalk.yellow(
              'This node missed its heartbeat window. It receives no new rooms; the rooms it already had are left running.',
            )}\n`,
          );
        }
      }),
    );

  servers
    .command('drain <server>')
    .description('Stop sending new rooms to a server, without disconnecting anyone')
    .option('--undo', 'put the server back into the allocation pool')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (name: string, opts: { undo?: boolean; json?: boolean }) => {
        const { client } = await getAuthenticatedApiClient();
        const server = await client.drainRtcServer(name, !opts.undo);

        if (opts.json) {
          printJson(server);
          return;
        }

        if (opts.undo) {
          printSuccess(`${name} is accepting new rooms again`);
          return;
        }
        printSuccess(`${name} is draining`);
        process.stdout.write(
          `\n${chalk.dim(
            `Existing rooms keep running and drain as calls end; ${server.activeRooms} still on this node.`,
          )}\n`,
        );
      }),
    );
}
