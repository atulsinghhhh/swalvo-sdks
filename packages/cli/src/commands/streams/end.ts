import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printJson, printSuccess } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerStreamsEndCommand(streams: Command): void {
  streams
    .command('end <streamId>')
    .description('End a live stream; terminal; it cannot be restarted')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (streamId: string, opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const stream = await client.endStream(projectId, streamId);

        if (opts.json) {
          printJson(stream);
          return;
        }

        printSuccess('Stream ended');
      }),
    );
}
