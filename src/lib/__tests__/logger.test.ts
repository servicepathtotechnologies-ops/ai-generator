import { afterEach, describe, expect, it, jest } from '@jest/globals';

const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function loadLoggerWithEnv(env: { LOG_LEVEL?: string; NODE_ENV?: string }) {
  if (env.LOG_LEVEL === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = env.LOG_LEVEL;
  }

  if (env.NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = env.NODE_ENV;
  }

  jest.resetModules();
  return require('../logger') as typeof import('../logger');
}

describe('logger', () => {
  afterEach(() => {
    if (ORIGINAL_LOG_LEVEL === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL;
    }

    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }

    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('defaults to INFO outside production', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { logger } = loadLoggerWithEnv({ NODE_ENV: 'test' });

    logger.debug('debug detail');
    logger.info('service ready');
    logger.warn('service warning');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('service ready');
    expect(warnSpy).toHaveBeenCalledWith('service warning');
  });

  it('honors DEBUG log level with the debug prefix', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { logger } = loadLoggerWithEnv({ LOG_LEVEL: 'debug', NODE_ENV: 'production' });

    logger.debug('request context', { requestId: 'req-123' });

    expect(logSpy).toHaveBeenCalledWith('[DEBUG]', 'request context', { requestId: 'req-123' });
  });

  it('falls back to WARN in production when LOG_LEVEL is invalid', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { logger } = loadLoggerWithEnv({ LOG_LEVEL: 'verbose', NODE_ENV: 'production' });

    logger.info('suppressed info');
    logger.warn('visible warning');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('visible warning');
  });
});
