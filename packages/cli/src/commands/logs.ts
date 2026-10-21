import { Command } from 'commander';
import { printInfo, printJson } from '../lib/output.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Stream developer-facing logs for the current project')
    .option('-f, --follow', 'follow the log stream')
    .option('--json', 'output as JSON')
    .action(async (opts: { json?: boolean }) => {
      // There's no developer-safe logs endpoint on the Control API yet, so
      // this is the honest answer until one ships. Not a bug, not a
      // placeholder.
      const message = 'Logs are not available for this project yet.';
      if (opts.json) {
        printJson({ available: false, message });
        return;
      }
      printInfo(message);
    });
}
