import { jest } from '@jest/globals';
import { buildCli } from '../../src/cli.js';

export class ProcessExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the real commander program in-process: same command tree, same
 * action handlers, same error handling.
 *
 * process.exit is intercepted, so a genuine exit-code path doesn't kill the
 * test worker, and stdout/stderr are captured for assertions. The caller
 * has to mock `global.fetch` before invoking this.
 */
export async function runCli(args: string[]): Promise<CliRunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  });

  let exitCode = 0;
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new ProcessExitSignal(exitCode);
  }) as never);

  try {
    const program = buildCli();
    await program.parseAsync(['node', 'swalvo', ...args]);
  } catch (error) {
    if (!(error instanceof ProcessExitSignal)) throw error;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

type FetchHandler = (
  url: string,
  init: RequestInit,
) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

/** Routes mocked fetch calls by "METHOD path", which keeps integration tests declarative, not dependent on call order. */
export function mockApi(routes: Record<string, FetchHandler>) {
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname;
    const key = `${method} ${path}`;
    const handler = routes[key];
    if (!handler) {
      throw new Error(`No mock route registered for "${key}" (available: ${Object.keys(routes).join(', ')})`);
    }
    const result = await handler(String(url), init ?? {});
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    } as Response;
  }) as unknown as typeof fetch;
}
