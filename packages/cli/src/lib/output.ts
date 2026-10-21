import chalk from 'chalk';

/** Prints exactly one JSON value to stdout and nothing else, so it's safe to pipe. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function printSuccess(message: string): void {
  process.stdout.write(`${chalk.green('✔')} ${message}\n`);
}

export function printInfo(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** A "Label:\nvalue" block, the style `whoami` and `projects inspect` use. */
export function printField(label: string, value: string): void {
  process.stdout.write(`${chalk.dim(label + ':')}\n${value}\n`);
}

export interface TableColumn<T> {
  header: string;
  value: (row: T) => string;
}

/** Dependency-free table, widths sized from the content. Think `docker ps` or `kubectl get`. */
export function printTable<T>(rows: T[], columns: TableColumn<T>[]): void {
  const widths = columns.map((col) => Math.max(col.header.length, ...rows.map((row) => col.value(row).length)));

  const headerLine = columns.map((col, i) => col.header.padEnd(widths[i])).join('   ');
  process.stdout.write(chalk.dim(headerLine) + '\n');

  for (const row of rows) {
    const line = columns.map((col, i) => col.value(row).padEnd(widths[i])).join('   ');
    process.stdout.write(line.trimEnd() + '\n');
  }
}

export function printEmpty(title: string, hint?: string): void {
  process.stdout.write(`${title}\n`);
  if (hint) process.stdout.write(`${chalk.dim(hint)}\n`);
}

export function statusIcon(status: 'up' | 'down' | 'unknown'): string {
  if (status === 'up') return chalk.green('✓');
  if (status === 'down') return chalk.red('✗');
  return chalk.yellow('?');
}
