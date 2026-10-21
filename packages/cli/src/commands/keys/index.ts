import { Command } from 'commander';
import { registerKeysListCommand } from './list.js';
import { registerKeysCreateCommand } from './create.js';
import { registerKeysRevokeCommand } from './revoke.js';

export function registerKeysCommand(program: Command): void {
  const keys = program.command('keys').description("Manage a project's API keys");

  registerKeysListCommand(keys);
  registerKeysCreateCommand(keys);
  registerKeysRevokeCommand(keys);
}
