import { Command } from 'commander';
import { getAuthenticatedApiClient } from '../../lib/context.js';
import { resolveProjectId } from '../../lib/project-context.js';
import { printJson, printSuccess } from '../../lib/output.js';
import { withErrorHandling } from '../../lib/run.js';
import { CliError } from '../../lib/errors.js';

export function registerStreamsUpdateCommand(streams: Command): void {
  streams
    .command('update <streamId>')
    .description("Update a stream's metadata; title, description, category, etc. (never its status)")
    .option('-p, --project <project>', 'project ID (overrides the current project context)')
    .option('--title <title>', 'a new title')
    .option('--description <text>', 'a new description')
    .option('--category <category>', 'a new category label')
    .option('--language <language>', 'e.g. en')
    .option('--visibility <visibility>', 'PUBLIC | PRIVATE | AUTHENTICATED')
    .option('--json', 'output as JSON')
    .action(
      withErrorHandling(
        async (
          streamId: string,
          opts: {
            project?: string;
            title?: string;
            description?: string;
            category?: string;
            language?: string;
            visibility?: string;
            json?: boolean;
          },
        ) => {
          const projectId = await resolveProjectId(opts.project);
          const visibility = parseVisibility(opts.visibility);

          if (
            opts.title === undefined &&
            opts.description === undefined &&
            opts.category === undefined &&
            opts.language === undefined &&
            visibility === undefined
          ) {
            throw new CliError('usage', 'Nothing to update.', {
              suggestion: 'Pass at least one of --title, --description, --category, --language, --visibility.',
            });
          }

          const { client } = await getAuthenticatedApiClient();
          const stream = await client.updateStream(projectId, streamId, {
            title: opts.title,
            description: opts.description,
            category: opts.category,
            language: opts.language,
            visibility,
          });

          if (opts.json) {
            printJson(stream);
            return;
          }

          printSuccess('Stream updated');
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
