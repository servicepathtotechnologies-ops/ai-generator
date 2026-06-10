import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { join } from 'path';

const CWD_ENV_PATH = join(process.cwd(), '.env');

type LoaderOptions = {
  existsSync: (path: unknown) => boolean;
  configResults?: Array<{ error?: Error }>;
};

function loadEnvLoader({ existsSync, configResults = [{}] }: LoaderOptions) {
  let configCall = 0;
  const existsSyncMock = jest.fn(existsSync);
  const configMock = jest.fn((_options?: unknown) => {
    const result = configResults[Math.min(configCall, configResults.length - 1)];
    configCall += 1;
    return result;
  });

  jest.resetModules();
  jest.doMock('fs', () => ({
    existsSync: existsSyncMock,
  }));
  jest.doMock('dotenv', () => ({
    config: configMock,
  }));

  require('../env-loader');

  return { configMock, existsSyncMock };
}

describe('env-loader', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    jest.dontMock('dotenv');
    jest.dontMock('fs');
  });

  it('loads the cwd .env candidate when it exists', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const { configMock, existsSyncMock } = loadEnvLoader({
      existsSync: (path) => path === CWD_ENV_PATH,
    });

    expect(existsSyncMock).toHaveBeenCalledWith(CWD_ENV_PATH);
    expect(configMock).toHaveBeenCalledTimes(1);
    expect(configMock).toHaveBeenCalledWith({ path: CWD_ENV_PATH, override: false });
    expect(logSpy).toHaveBeenCalledWith(`[env-loader] Loaded ${CWD_ENV_PATH}`);
  });

  it('uses dotenv default search when no explicit candidate exists', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const { configMock, existsSyncMock } = loadEnvLoader({
      existsSync: () => false,
    });

    expect(existsSyncMock).toHaveBeenCalledTimes(3);
    expect(configMock).toHaveBeenCalledTimes(1);
    expect(configMock).toHaveBeenCalledWith({ override: false });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('continues through candidates when dotenv reports a load error', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const { configMock } = loadEnvLoader({
      existsSync: () => true,
      configResults: [{ error: new Error('invalid env') }, {}],
    });

    expect(configMock).toHaveBeenCalledTimes(2);
    expect(configMock.mock.calls[0]?.[0]).toMatchObject({ override: false });
    expect(configMock.mock.calls[1]?.[0]).toMatchObject({ override: false });

    const loadedPath = (configMock.mock.calls[1]?.[0] as { path: string }).path;
    expect(logSpy).toHaveBeenCalledWith(`[env-loader] Loaded ${loadedPath}`);
  });
});
