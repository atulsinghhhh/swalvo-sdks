import { createLogger } from '../src/logger';

describe('createLogger', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults to silent — nothing reaches the console', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger();

    logger.error('boom');
    logger.warn('careful');
    logger.info('fyi');
    logger.debug('trace');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('"warn" level logs error and warn, but not info/debug', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLogger('warn');

    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('"debug" level logs everything', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLogger('debug');

    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('prefixes every message so log lines are attributable to the SDK', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('error').error('something broke');
    expect(errorSpy).toHaveBeenCalledWith('[swalvo-rtc]', 'something broke');
  });
});
