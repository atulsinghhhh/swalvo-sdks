import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { CliError } from './errors.js';

/** True when stdin isn't a real tty: CI, pipes, that sort of thing. Every interactive prompt checks it first. */
export function isNonInteractive(): boolean {
  return !process.stdin.isTTY || !process.stdout.isTTY;
}

/**
 * Confirmation gate for destructive actions. `--yes` skips it. Without
 * `--yes` in a non-interactive shell we fail loudly instead of hang on a
 * prompt nobody's there to answer.
 */
export async function confirm(message: string, opts: { assumeYes?: boolean }): Promise<boolean> {
  if (opts.assumeYes) return true;

  if (isNonInteractive()) {
    throw new CliError('usage', 'This is a destructive action and requires confirmation.', {
      suggestion: 'Re-run with --yes to confirm non-interactively',
    });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} ${chalk.dim('[y/N]')} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Minimal numbered-list picker. No extra dependency; it prints to scrollback, not redrawing like a real TUI. */
export async function selectFromList<T>(message: string, items: T[], label: (item: T) => string): Promise<T> {
  if (isNonInteractive()) {
    throw new CliError('usage', message, {
      suggestion: 'Not running in an interactive terminal; pass the target explicitly instead',
    });
  }
  if (items.length === 0) {
    throw new CliError('not_found', 'Nothing to select from.');
  }

  process.stdout.write(`${chalk.bold(message)}\n`);
  items.forEach((item, i) => {
    process.stdout.write(`  ${chalk.dim(`${i + 1}.`)} ${label(item)}\n`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question(`Select 1-${items.length}: `)).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < items.length) {
        return items[index];
      }
      process.stdout.write(chalk.red(`Enter a number between 1 and ${items.length}.\n`));
    }
  } finally {
    rl.close();
  }
}
