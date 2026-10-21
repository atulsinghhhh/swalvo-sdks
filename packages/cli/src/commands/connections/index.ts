import { Command } from 'commander';
import { registerConnectionsListCommand } from './list.js';
import { registerConnectionsInspectCommand } from './inspect.js';

export function registerConnectionsCommand(program: Command): void {
  const connections = program.command('connections').description("Inspect a project's real RTC connections");

  registerConnectionsListCommand(connections);
  registerConnectionsInspectCommand(connections);
}
