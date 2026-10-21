import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { printField, printJson } from '../../lib/output.js';
import { lookupProject } from '../../lib/project-lookup.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerProjectsInspectCommand(projects: Command): void {
  projects
    .command('inspect <project>')
    .description('Show details for a Swalvo project')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (projectRef: string, opts: { json?: boolean }) => {
        const { client } = await getAuthenticatedApiClient();
        const project = await lookupProject(client, projectRef);

        if (opts.json) {
          printJson(project);
          return;
        }

        printField('Name', project.name);
        printField('ID', project.id);
        printField('Environment', 'development');
        // No per-project RTC endpoint yet; everything shares one Control
        // API deployment. `swalvo init` has the real token-mint flow.
        printField('RTC endpoint', 'See `swalvo init` for SDK setup');
        printField('Status', project.status);
        printField('Created', new Date(project.createdAt).toLocaleString());
      }),
    );
}
