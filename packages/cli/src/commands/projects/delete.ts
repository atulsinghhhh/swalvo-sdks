import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { confirm } from '../../lib/prompt.js';
import { printInfo, printJson, printSuccess } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerProjectsDeleteCommand(projects: Command): void {
  projects
    .command('delete <project>')
    .description('Archive a Swalvo project (soft delete; history is retained)')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (projectId: string, opts: { yes?: boolean; json?: boolean }) => {
        const { client } = await getAuthenticatedApiClient();
        const project = await client.getProject(projectId);

        const confirmed = await confirm(`Delete project "${project.name}"?`, { assumeYes: opts.yes });
        if (!confirmed) {
          printInfo('Cancelled.');
          return;
        }

        await client.deleteProject(projectId);

        if (opts.json) {
          printJson({ deleted: true, id: project.id, name: project.name });
          return;
        }
        printSuccess(`Deleted project "${project.name}"`);
      }),
    );
}
