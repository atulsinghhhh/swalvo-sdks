import { Command } from 'commander';
import { getPublicApiClient, requireCredentials } from '../lib/context.js';
import { resolveProjectId } from '../lib/project-context.js';
import { SwalvoApiClient } from '../lib/api-client.js';
import { printField, printJson } from '../lib/output.js';
import { statusIcon } from '../lib/output.js';
import { withErrorHandling } from '../lib/run.js';
import type { DependencyStatus } from '../lib/types.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show Swalvo infrastructure health and the current project')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; json?: boolean }) => {
        const client = await getPublicApiClient();
        const health = await client.getHealth();

        let projectName: string | undefined;
        try {
          const projectId = await resolveProjectId(opts.project);
          const credentials = await requireCredentials();
          const authedClient = new SwalvoApiClient(credentials.apiUrl, credentials.token);
          const project = await authedClient.getProject(projectId);
          projectName = project.name;
        } catch {
          // No project context, or not logged in. Still report infra
          // health; just skip the project line.
        }

        if (opts.json) {
          printJson({ ...health, project: projectName ?? null });
          return;
        }

        // Signaling runs in the same process as this /health check, and
        // there's no separate probe for it. Reaching /health at all is the
        // best signal we've got.
        const apiReachable: DependencyStatus = 'up';
        printDependency('API', apiReachable);
        printDependency('Signaling', apiReachable);
        printDependency('Database', health.dependencies.database);
        printDependency('SFU', health.dependencies.sfu);
        printDependency('TURN', health.dependencies.turn);

        if (projectName) {
          process.stdout.write('\n');
          printField('Project', projectName);
        }
      }),
    );
}

function printDependency(label: string, status: DependencyStatus): void {
  process.stdout.write(`${statusIcon(status)} ${label}: ${status === 'up' ? 'Healthy' : 'Unhealthy'}\n`);
}
