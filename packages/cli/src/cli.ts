import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { ExitCode } from './lib/errors.js';
import { setDebugEnabled } from './lib/logger.js';
import { registerLoginCommand } from './commands/login.js';
import { registerLogoutCommand } from './commands/logout.js';
import { registerWhoamiCommand } from './commands/whoami.js';
import { registerInitCommand } from './commands/init.js';
import { registerDevCommand } from './commands/dev.js';
import { registerVersionCommand } from './commands/version.js';
import { registerStatusCommand } from './commands/status.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerProjectsCommand } from './commands/projects/index.js';
import { registerKeysCommand } from './commands/keys/index.js';
import { registerRoomsCommand } from './commands/rooms/index.js';
import { registerRtcCommand } from './commands/rtc/index.js';
import { registerChatCommand } from './commands/chat/index.js';
import { registerStreamsCommand } from './commands/streams/index.js';
import { registerConfigCommand } from './commands/config/index.js';
import { registerSdkCommand } from './commands/sdk/index.js';
import { registerConnectionsCommand } from './commands/connections/index.js';
import { registerErrorsCommand } from './commands/errors/index.js';
import { registerDiagnosticsCommand } from './commands/diagnostics.js';

export function buildCli(): Command {
  const program = new Command();

  program
    .name('swalvo')
    .description('Swalvo CLI; manage projects, API keys, rooms, RTC, chat, and live streams from the terminal.')
    .version(CLI_VERSION, '--version', 'output the current version')
    .option('--debug', 'print verbose request/response logs (never includes secrets)')
    .hook('preAction', (thisCommand) => {
      setDebugEnabled(Boolean(thisCommand.opts().debug));
    })
    // Commander's default exit codes don't match our documented table, so
    // parse failures (bad args, unknown option or command) get mapped to 2.
    // --help and --version still exit 0. Runtime errors thrown inside an
    // action go through withErrorHandling and never reach here.
    .exitOverride((err) => {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
        process.exit(ExitCode.Success);
      }
      process.exit(ExitCode.InvalidUsage);
    });

  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerWhoamiCommand(program);
  registerInitCommand(program);
  registerDevCommand(program);
  registerVersionCommand(program);
  registerStatusCommand(program);
  registerLogsCommand(program);
  registerProjectsCommand(program);
  registerKeysCommand(program);
  registerRoomsCommand(program);
  registerRtcCommand(program);
  registerChatCommand(program);
  registerStreamsCommand(program);
  registerConfigCommand(program);
  registerSdkCommand(program);
  registerConnectionsCommand(program);
  registerErrorsCommand(program);
  registerDiagnosticsCommand(program);

  return program;
}
