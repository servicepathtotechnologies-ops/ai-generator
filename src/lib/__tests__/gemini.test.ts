import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { callGemini } from '../gemini';

const ORIGINAL_GEMINI_API_KEYS = process.env.GEMINI_API_KEYS;
const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_FETCH = globalThis.fetch;

type FetchMock = jest.MockedFunction<typeof fetch>;

function setGeminiEnv(env: { GEMINI_API_KEYS?: string; GEMINI_API_KEY?: string }) {
  if (env.GEMINI_API_KEYS === undefined) {
    delete process.env.GEMINI_API_KEYS;
  } else {
    process.env.GEMINI_API_KEYS = env.GEMINI_API_KEYS;
  }

  if (env.GEMINI_API_KEY === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  }
}

function mockFetch(...responses: unknown[]): FetchMock {
  const fetchMock = jest.fn();

  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response as never);
  }

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock as unknown as FetchMock;
}

describe('callGemini', () => {
  afterEach(() => {
    setGeminiEnv({
      GEMINI_API_KEYS: ORIGINAL_GEMINI_API_KEYS,
      GEMINI_API_KEY: ORIGINAL_GEMINI_API_KEY,
    });
    globalThis.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
  });

  it('uses the first configured pooled key and sends the Gemini request body', async () => {
    setGeminiEnv({
      GEMINI_API_KEYS: ' first-key, second-key , ',
      GEMINI_API_KEY: 'fallback-key',
    });

    const fetchMock = mockFetch({
      ok: true,
      json: jest.fn(async () => ({
        candidates: [{ content: { parts: [{ text: 'Generated workflow' }] } }],
        usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 9 },
      })),
    });

    await expect(
      callGemini('system instructions', 'build a workflow', 'gemini-2.0-flash', 0.25),
    ).resolves.toEqual({
      text: 'Generated workflow',
      promptTokens: 17,
      completionTokens: 9,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=first-key',
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request.body as string)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'build a workflow' }] }],
      systemInstruction: { parts: [{ text: 'system instructions' }] },
      generationConfig: { temperature: 0.25 },
    });
  });

  it('falls back to the single key and estimates token counts when usage metadata is absent', async () => {
    setGeminiEnv({ GEMINI_API_KEY: 'single-key' });

    mockFetch({
      ok: true,
      json: jest.fn(async () => ({
        candidates: [{ content: { parts: [{ text: 'done' }] } }],
      })),
    });

    await expect(callGemini('12345678', 'go', 'gemini-pro', 0)).resolves.toEqual({
      text: 'done',
      promptTokens: 2,
      completionTokens: 1,
    });
  });

  it('rotates to the next pooled key after a 429 response', async () => {
    setGeminiEnv({ GEMINI_API_KEYS: 'quota-key, working-key' });

    const fetchMock = mockFetch(
      {
        ok: false,
        status: 429,
        text: jest.fn(async () => 'quota exhausted'),
      },
      {
        ok: true,
        json: jest.fn(async () => ({
          candidates: [{ content: { parts: [{ text: 'second key response' }] } }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
        })),
      },
    );

    await expect(callGemini('system', 'user', 'gemini-pro', 0.7)).resolves.toEqual({
      text: 'second key response',
      promptTokens: 3,
      completionTokens: 4,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('key=quota-key');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('key=working-key');
  });

  it('fails fast on non-quota Gemini API errors', async () => {
    setGeminiEnv({ GEMINI_API_KEYS: 'bad-key, unused-key' });

    const fetchMock = mockFetch({
      ok: false,
      status: 500,
      text: jest.fn(async () => 'server unavailable'),
    });

    await expect(callGemini('system', 'user', 'gemini-pro', 0.7)).rejects.toThrow(
      'Gemini API 500: server unavailable',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws before fetching when no API key is configured', async () => {
    setGeminiEnv({});
    const fetchMock = mockFetch();

    await expect(callGemini('system', 'user', 'gemini-pro', 0.7)).rejects.toThrow(
      '[ai-generator] No GEMINI_API_KEY configured',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
