import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printEmpty, printJson } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerStreamsInspectCommand(streams: Command): void {
  streams
    .command('inspect <streamId>')
    .description('Show a stream, its live viewer count, and its registered hosts')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (streamId: string, opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const stream = await client.getStream(projectId, streamId);

        if (opts.json) {
          printJson(stream);
          return;
        }

        process.stdout.write(`${chalk.bold(stream.title)} ${chalk.dim(`(${stream.id})`)}\n\n`);
        process.stdout.write(`${chalk.dim('Status:')} ${stream.status}\n`);
        process.stdout.write(
          `${chalk.dim('Viewers:')} ${stream.viewerCount === null ? 'unknown' : stream.viewerCount} ${chalk.dim(`(peak ${stream.peakViewerCount})`)}\n`,
        );
        process.stdout.write(`${chalk.dim('Visibility:')} ${stream.visibility}\n\n`);

        if (stream.hosts.length === 0) {
          printEmpty('No registered hosts.');
          return;
        }

        process.stdout.write(`${chalk.dim('Hosts:')}\n\n`);
        for (const host of stream.hosts) {
          process.stdout.write(`${host.identity} ${chalk.dim(`(${host.role})`)}\n`);
        }
      }),
    );
}
