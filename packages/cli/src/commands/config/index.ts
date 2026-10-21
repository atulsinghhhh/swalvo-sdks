import { Command } from 'commander';
import { CliError } from '../../lib/errors.js';
import { CONFIG_KEYS, isConfigKey, readCliConfig, updateCliConfig } from '../../lib/cli-config.js';
import { printJson, printSuccess, printTable } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Manage local CLI configuration (never secrets)');

  config
    .command('get <key>')
    .description(`Print one config value (${CONFIG_KEYS.join(', ')})`)
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (key: string, opts: { json?: boolean }) => {
        if (!isConfigKey(key)) {
          throw new CliError('usage', `Unknown config key "${key}".`, {
            suggestion: `Valid keys: ${CONFIG_KEYS.join(', ')}`,
          });
        }
        const current = await readCliConfig();
        const value = current[key] ?? '';

        if (opts.json) {
          printJson({ [key]: value });
          return;
        }
        process.stdout.write(`${value}\n`);
      }),
    );

  config
    .command('set <key> <value>')
    .description(`Set one config value (${CONFIG_KEYS.join(', ')})`)
    .action(
      withErrorHandling(async (key: string, value: string) => {
        if (!isConfigKey(key)) {
          throw new CliError('usage', `Unknown config key "${key}".`, {
            suggestion: `Valid keys: ${CONFIG_KEYS.join(', ')}`,
          });
        }
        await updateCliConfig({ [key]: value });
        printSuccess(`${key} set.`);
      }),
    );

  config
    .command('list')
    .description('List all local config values (never includes credentials)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(async (opts: { json?: boolean }) => {
        const current = await readCliConfig();

        if (opts.json) {
          printJson(current);
          return;
        }

        printTable(
          CONFIG_KEYS.map((key) => ({ key, value: current[key] ?? '' })),
          [
            { header: 'KEY', value: (row) => row.key },
            { header: 'VALUE', value: (row) => row.value },
          ],
        );
      }),
    );
}
