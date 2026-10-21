import { Command } from 'commander';
import { CLI_VERSION } from '../version.js';
import { printInfo } from '../lib/output.js';

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Print the Swalvo CLI version')
    .action(() => {
      printInfo(`Swalvo CLI ${CLI_VERSION}`);
    });
}
