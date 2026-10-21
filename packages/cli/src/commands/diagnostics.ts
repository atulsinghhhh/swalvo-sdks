import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../lib/context.js';
import { resolveProjectId } from '../lib/project-context.js';
import { isSdkInPackageJson } from '../lib/sdk-check.js';
import { printField, printJson, statusIcon } from '../lib/output.js';
import { withErrorHandling } from '../lib/run.js';

export function registerDiagnosticsCommand(program: Command): void {
  program
    .command('diagnostics')
    .description('Run authenticated per-dependency diagnostics for the current project')
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { project?: string; json?: boolean }) => {
        const projectId = await resolveProjectId(opts.project);
        const { client } = await getAuthenticatedApiClient();
        const diagnostics = await client.getDiagnostics(projectId);
        const sdkInstalled = await isSdkInPackageJson();

        if (opts.json) {
          printJson({ ...diagnostics, sdk: { installed: sdkInstalled } });
          return;
        }

        printDependency('Swalvo API', diagnostics.api);
        printDependency('Authentication', diagnostics.authentication === 'ok' ? 'up' : 'down');
        printDependency('Signaling', diagnostics.dependencies.signaling);
        printDependency('SFU', diagnostics.dependencies.sfu);
        printDependency('TURN', diagnostics.dependencies.turn);
        process.stdout.write('\n');
        printField('Project', diagnostics.project.name);
        printField('Active connections', String(diagnostics.connections.active));

        process.stdout.write('\n');
        printField(
          'SDK (@swalvo/rtc) installed in this directory',
          sdkInstalled ? 'yes' : 'no; run `swalvo sdk install`',
        );

        // Connection-level diagnostics (ICE and signaling state, browser)
        // only exist for a live browser connection. See
        // Room.getDiagnostics() in @swalvo/rtc. This CLI process never
        // fabricates any of it.
        process.stdout.write(
          `\nFor live connection diagnostics (ICE state, browser, reconnect count), call room.getDiagnostics() from @swalvo/rtc in your running app; see docs/telemetry.md#client-side-diagnostics.\n`,
        );
      }),
    );
}

function printDependency(label: string, status: 'up' | 'down'): void {
  process.stdout.write(`${statusIcon(status)} ${label}: ${status === 'up' ? 'Healthy' : 'Unhealthy'}\n`);
}
