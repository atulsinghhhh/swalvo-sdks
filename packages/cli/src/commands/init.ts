import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedApiClient } from '../lib/context.js';
import { writeProjectConfig } from '../lib/project-config.js';
import { selectFromList } from '../lib/prompt.js';
import { CliError } from '../lib/errors.js';
import { detectPackageManager, installCommand } from '../lib/package-manager.js';
import { printSuccess } from '../lib/output.js';
import { withErrorHandling } from '../lib/run.js';
import type { Project } from '../lib/types.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Link this directory to a Swalvo project')
    .option('-p, --project <project>', 'project ID (skips the interactive picker)')
    .action(
      withErrorHandling(async (opts: { project?: string }) => {
        const { client } = await getAuthenticatedApiClient();

        let project: Project;
        if (opts.project) {
          project = await client.getProject(opts.project);
        } else {
          const projects = await client.listProjects();
          if (projects.length === 0) {
            throw new CliError('usage', 'You have no Swalvo projects yet.', {
              suggestion: 'Run `swalvo projects create <name>` first',
            });
          }
          project = await selectFromList('Select Swalvo project:', projects, (p) => p.name);
        }

        const path = await writeProjectConfig({ project: project.id });
        printSuccess('Project linked.');
        process.stdout.write(`\nCreated:\n${chalk.dim(path)}\n`);

        const manager = await detectPackageManager();
        process.stdout.write(
          `\n${chalk.bold('Next: install the SDK')}\n  ${chalk.cyan(installCommand(manager, '@swalvo/rtc'))}\n` +
            `  ${chalk.dim('(or run `swalvo sdk install`)')}\n`,
        );
      }),
    );
}
