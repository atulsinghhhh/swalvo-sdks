import { CliError, ExitCode, noProjectSelectedError, notLoggedInError } from '../../src/lib/errors.js';

describe('CliError', () => {
  it('maps each kind to its documented exit code', () => {
    expect(new CliError('usage', 'x').exitCode).toBe(ExitCode.InvalidUsage);
    expect(new CliError('auth', 'x').exitCode).toBe(ExitCode.AuthenticationFailure);
    expect(new CliError('authz', 'x').exitCode).toBe(ExitCode.AuthorizationFailure);
    expect(new CliError('not_found', 'x').exitCode).toBe(ExitCode.NotFound);
    expect(new CliError('network', 'x').exitCode).toBe(ExitCode.NetworkFailure);
    expect(new CliError('general', 'x').exitCode).toBe(ExitCode.GeneralFailure);
  });

  it('carries an optional suggestion and cause without corrupting the message', () => {
    const cause = new Error('underlying');
    const error = new CliError('network', 'Could not reach the API', { suggestion: 'Check your connection', cause });

    expect(error.message).toBe('Could not reach the API');
    expect(error.suggestion).toBe('Check your connection');
    expect(error.cause).toBe(cause);
  });

  it('is a real Error instance (name set, instanceof Error)', () => {
    const error = new CliError('general', 'boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CliError');
  });
});

describe('notLoggedInError', () => {
  it('is an auth-kind error suggesting `swalvo login`', () => {
    const error = notLoggedInError();
    expect(error.kind).toBe('auth');
    expect(error.exitCode).toBe(ExitCode.AuthenticationFailure);
    expect(error.suggestion).toContain('swalvo login');
  });
});

describe('noProjectSelectedError', () => {
  it('is a usage-kind error suggesting init or projects use', () => {
    const error = noProjectSelectedError();
    expect(error.kind).toBe('usage');
    expect(error.exitCode).toBe(ExitCode.InvalidUsage);
    expect(error.suggestion).toContain('swalvo init');
    expect(error.suggestion).toContain('swalvo projects use');
  });
});
