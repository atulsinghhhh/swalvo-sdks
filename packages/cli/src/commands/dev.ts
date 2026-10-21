import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../lib/context.js';
import { readProjectConfig } from '../lib/project-config.js';
import { isSdkInPackageJson } from '../lib/sdk-check.js';
import { CliError } from '../lib/errors.js';
import { printField, printJson } from '../lib/output.js';
import { withErrorHandling } from '../lib/run.js';

export function registerDevCommand(program: Command): void {
  program
    .command('dev')
    .description('Check that this directory is ready for Swalvo development')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { json?: boolean }) => {
        const projectConfig = await readProjectConfig();
        if (!projectConfig) {
          throw new CliError('usage', 'This directory is not linked to a Swalvo project.', {
            suggestion: 'Run `swalvo init`',
          });
        }

        const { client } = await getAuthenticatedApiClient();
        const project = await client.getProject(projectConfig.project);

        const [health, sdkInstalled] = await Promise.all([
          client.getHealth().catch(() => undefined),
          isSdkInPackageJson(),
        ]);

        const apiConnected = health !== undefined;
        const rtcAvailable = health?.dependencies.sfu === 'up';

        if (opts.json) {
          printJson({
            project: project.name,
            projectId: project.id,
            apiConnected,
            rtcAvailable,
            sdkInstalled,
            environment: 'development',
          });
          return;
        }

        printField('Swalvo project', project.name);
        printField('Project ID', project.id);
        process.stdout.write('\n');
        process.stdout.write(`API:\n${checkLine(apiConnected, 'Connected', 'Could not reach the Control API')}\n\n`);
        process.stdout.write(`RTC:\n${checkLine(rtcAvailable, 'Available', 'SFU is unreachable')}\n\n`);
        process.stdout.write(
          `SDK:\n${checkLine(sdkInstalled, '@swalvo/rtc installed', '@swalvo/rtc is not installed; run `swalvo sdk install`')}\n\n`,
        );
        printField('Environment', 'development');

        if (apiConnected && rtcAvailable && sdkInstalled) {
          process.stdout.write(`\n${chalk.green('Ready for development.')}\n`);
        }
      }),
    );
}

function checkLine(ok: boolean, okMessage: string, failMessage: string): string {
  return ok ? `${chalk.green('✓')} ${okMessage}` : `${chalk.red('✗')} ${failMessage}`;
}
