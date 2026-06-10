import { afterEach, describe, expect, it, jest } from '@jest/globals';

const ORIGINAL_WORKER_URL = process.env.WORKER_URL;
const ORIGINAL_FETCH = globalThis.fetch;

type FetchMock = jest.MockedFunction<typeof fetch>;

function setWorkerUrl(value?: string) {
  if (value === undefined) {
    delete process.env.WORKER_URL;
  } else {
    process.env.WORKER_URL = value;
  }
}

function mockFetchWithResponse(response: unknown): FetchMock {
  const fetchMock = jest.fn(async () => response) as unknown as FetchMock;
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function loadCatalogModule(workerUrl?: string) {
  setWorkerUrl(workerUrl);

  const loggerMock = {
    info: jest.fn(),
    warn: jest.fn(),
  };

  jest.resetModules();
  jest.doMock('../logger', () => ({ logger: loggerMock }));

  const catalogModule = require('../catalog') as typeof import('../catalog');
  return { catalogModule, loggerMock };
}

describe('catalog', () => {
  afterEach(() => {
    setWorkerUrl(ORIGINAL_WORKER_URL);
    globalThis.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
    jest.resetModules();
    jest.dontMock('../logger');
  });

  it('fetches the node catalog from the configured worker URL without a trailing slash', async () => {
    const fetchMock = mockFetchWithResponse({
      ok: true,
      json: jest.fn(async () => ({ catalog: 'fixture catalog' })),
    });

    const { catalogModule, loggerMock } = loadCatalogModule('https://worker.example.com/');

    await expect(catalogModule.getNodeCatalog()).resolves.toBe('fixture catalog');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://worker.example.com/api/nodes/catalog');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      signal: expect.any(AbortSignal),
    });
    expect(loggerMock.info).toHaveBeenCalledWith('[catalog] Cached (15 chars)');
  });

  it('returns the cached catalog on repeated calls within the cache window', async () => {
    const jsonMock = jest.fn(async () => ({ catalog: 'cached catalog' }));
    const fetchMock = mockFetchWithResponse({
      ok: true,
      json: jsonMock,
    });

    const { catalogModule } = loadCatalogModule();

    await expect(catalogModule.getNodeCatalog()).resolves.toBe('cached catalog');
    await expect(catalogModule.getNodeCatalog()).resolves.toBe('cached catalog');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the worker catalog endpoint returns a non-ok response', async () => {
    mockFetchWithResponse({
      ok: false,
      status: 503,
    });

    const { catalogModule } = loadCatalogModule();

    await expect(catalogModule.getNodeCatalog()).rejects.toThrow(
      'Worker catalog endpoint returned 503',
    );
  });

  it('swallows pre-warm failures and logs a warning', async () => {
    const fetchError = new Error('worker unavailable');
    const fetchMock = jest.fn(async () => {
      throw fetchError;
    }) as unknown as FetchMock;
    globalThis.fetch = fetchMock;

    const { catalogModule, loggerMock } = loadCatalogModule();

    await expect(catalogModule.warmCatalog()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[catalog] Pre-warm failed (worker not ready yet?):',
      fetchError,
    );
  });
});
