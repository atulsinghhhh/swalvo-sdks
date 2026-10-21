import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printField, printJson, printSuccess } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';
import { CliError } from '../../lib/errors.js';

export function registerStreamsCreateCommand(streams: Command): void {
  streams
    .command('create <title>')
    .description('Create a live stream; a dedicated RTC room plus an attached chat conversation')
    .requiredOption('--host <identity>', "the stream's host identity, registered as its HOST")
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--description <text>', 'a description for the stream')
    .option('--category <category>', 'a category label')
    .option('--language <language>', 'e.g. en')
    .option('--visibility <visibility>', 'PUBLIC | PRIVATE | AUTHENTICATED (default: PUBLIC)')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(
        async (
          title: string,
          opts: {
            host: string;
            project?: string;
            description?: string;
            category?: string;
            language?: string;
            visibility?: string;
            json?: boolean;
          },
        ) => {
          const projectId = await resolveProjectId(opts.project);
          const visibility = parseVisibility(opts.visibility);
          const { client } = await getAuthenticatedApiClient();
          const stream = await client.createStream(projectId, {
            title,
            hostIdentity: opts.host,
            description: opts.description,
            category: opts.category,
            language: opts.language,
            visibility,
          });

          if (opts.json) {
            printJson(stream);
            return;
          }

          printSuccess('Stream created');
          process.stdout.write('\n');
          printField('ID', stream.id);
          printField('Status', stream.status);
          printField('Title', stream.title);
        },
      ),
    );
}

function parseVisibility(value?: string): 'PUBLIC' | 'PRIVATE' | 'AUTHENTICATED' | undefined {
  if (!value) return undefined;
  const normalised = value.trim().toUpperCase();
  if (normalised === 'PUBLIC' || normalised === 'PRIVATE' || normalised === 'AUTHENTICATED') {
    return normalised;
  }
  throw new CliError('usage', `Unknown visibility "${value}".`, {
    suggestion: 'Use one of: PUBLIC, PRIVATE, AUTHENTICATED.',
  });
}
