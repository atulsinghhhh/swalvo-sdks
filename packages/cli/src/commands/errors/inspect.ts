import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printField, printJson } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerErrorsInspectCommand(errors: Command): void {
  errors
    .command('inspect <errorId>')
    .description('Show one classified error in full, with its connection if any')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (errorId: string, opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const error = await client.getError(projectId, errorId);

        if (opts.json) {
          printJson(error);
          return;
        }

        process.stdout.write(`${chalk.bold.red(error.category)}\n\n`);
        process.stdout.write(`${error.message}\n\n`);
        if (error.likelyCause) printField('Likely cause', error.likelyCause);
        if (error.suggestedAction) printField('Suggested action', error.suggestedAction);
        printField('When', new Date(error.timestamp).toLocaleString());
        if (error.connectionId) printField('Connection', error.connectionId);
        if (error.roomId) printField('Room', error.roomId);
        if (error.sdkVersion) printField('SDK', error.sdkVersion);
        if (error.platform) printField('Platform', error.platform);
      }),
    );
}
