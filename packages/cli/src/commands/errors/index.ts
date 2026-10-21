import { Command } from 'commander';
import { registerErrorsListCommand } from './list.js';
import { registerErrorsInspectCommand } from './inspect.js';

export function registerErrorsCommand(program: Command): void {
  const errors = program.command('errors').description("Inspect a project's classified RTC errors");

  registerErrorsListCommand(errors);
  registerErrorsInspectCommand(errors);
}
