import { buildCli } from './cli.js';

const program = buildCli();
program.parseAsync(process.argv);
