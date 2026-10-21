import { Command } from 'commander';
import chalk from 'chalk';
import { detectPackageManager, installCommand } from '../../lib/package-manager.js';
import { runCommand } from '../../lib/exec.js';
import { printInfo, printSuccess } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

const SDK_PACKAGE_NAME = '@swalvo/rtc';

export function registerSdkInstallCommand(sdk: Command): void {
  sdk
    .command('install')
    .description(`Install ${SDK_PACKAGE_NAME} using this project's detected package manager`)
    .option('--dry-run', 'print the install command instead of running it')
    .action(
      withErrorHandling(async (opts: { dryRun?: boolean }) => {
        const manager = await detectPackageManager();
        const command = installCommand(manager, SDK_PACKAGE_NAME);

        if (opts.dryRun) {
          printInfo(`Detected package manager: ${chalk.bold(manager)}`);
          printInfo(`Would run:\n\n  ${chalk.cyan(command)}\n`);
          return;
        }

        printInfo(`Installing ${SDK_PACKAGE_NAME} with ${chalk.bold(manager)}…\n`);
        const [bin, ...args] = command.split(' ');
        await runCommand(bin, args);
        printSuccess(`${SDK_PACKAGE_NAME} installed.`);
      }),
    );
}
