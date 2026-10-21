import { Command } from 'commander';
import { registerRoomsListCommand } from './list.js';
import { registerRoomsInspectCommand } from './inspect.js';
import { registerRoomsCreateCommand } from './create.js';

export function registerRoomsCommand(program: Command): void {
  const rooms = program.command('rooms').description("Inspect a project's rooms and live participants");

  registerRoomsListCommand(rooms);
  registerRoomsInspectCommand(rooms);
  registerRoomsCreateCommand(rooms);
}
