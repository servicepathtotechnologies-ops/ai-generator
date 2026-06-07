type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SILENT';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
};

function getLogLevel(): LogLevel {
  const envLevel = (process.env.LOG_LEVEL || '').toUpperCase() as LogLevel;
  if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, envLevel)) return envLevel;
  return process.env.NODE_ENV === 'production' ? 'WARN' : 'INFO';
}

const currentLevelValue = LOG_LEVELS[getLogLevel()];

const shouldLog = (level: LogLevel) => LOG_LEVELS[level] >= currentLevelValue;

export const logger = {
  debug: (...args: unknown[]) => { if (shouldLog('DEBUG')) console.log('[DEBUG]', ...args); },
  info:  (...args: unknown[]) => { if (shouldLog('INFO'))  console.log(...args); },
  warn:  (...args: unknown[]) => { if (shouldLog('WARN'))  console.warn(...args); },
  error: (...args: unknown[]) => { if (shouldLog('ERROR')) console.error(...args); },
};
