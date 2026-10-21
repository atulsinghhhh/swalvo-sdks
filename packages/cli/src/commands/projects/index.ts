import { Command } from 'commander';
import { registerProjectsCreateCommand } from './create.js';
import { registerProjectsListCommand } from './list.js';
import { registerProjectsInspectCommand } from './inspect.js';
import { registerProjectsDeleteCommand } from './delete.js';
import { registerProjectsUseCommand } from './use.js';

export function registerProjectsCommand(program: Command): void {
  const projects = program.command('projects').description('Manage Swalvo projects');

  registerProjectsCreateCommand(projects);
  registerProjectsListCommand(projects);
  registerProjectsInspectCommand(projects);
  registerProjectsDeleteCommand(projects);
  registerProjectsUseCommand(projects);
}
