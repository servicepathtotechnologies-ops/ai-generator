import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../lib/gemini', () => ({
  callGemini: jest.fn(),
}));

jest.mock('../../lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { callGemini } from '../../lib/gemini';
import { runPropertyPopulationJsonStage } from '../property-population';

const mockCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const validValues = { subject: 'Hello', body: 'World' };

function geminiResponse(payload: unknown) {
  return {
    text: JSON.stringify(payload),
    promptTokens: 10,
    completionTokens: 20,
  };
}

describe('runPropertyPopulationJsonStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns parsed values from a valid LLM response with correct llmCall metadata', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiResponse(validValues));

    const result = await runPropertyPopulationJsonStage({
      purpose: 'property_population',
      systemPrompt: 'system prompt',
      message: 'user message',
      correlationId: 'corr-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual(validValues);
    expect(result.llmCall).toEqual({
      model: 'gemini-3.5-flash',
      temperature: 0.1,
      promptTokens: 10,
      completionTokens: 20,
    });
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
    expect(mockCallGemini).toHaveBeenCalledWith('system prompt', 'user message', 'gemini-3.5-flash', 0.1);
  });

  it('strips markdown fences from the response', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: `\`\`\`json\n${JSON.stringify(validValues)}\n\`\`\``,
      promptTokens: 5,
      completionTokens: 15,
    });

    const result = await runPropertyPopulationJsonStage({
      purpose: 'property_population',
      systemPrompt: 'system',
      message: 'msg',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual(validValues);
  });

  it('retries on parse failure and succeeds on the second attempt', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'not valid json at all', promptTokens: 5, completionTokens: 3 })
      .mockResolvedValueOnce(geminiResponse(validValues));

    const result = await runPropertyPopulationJsonStage({
      purpose: 'property_population',
      systemPrompt: 'system',
      message: 'msg',
    });

    expect(result.ok).toBe(true);
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    // Second call must include the critical retry hint
    const secondCallMessage = (mockCallGemini.mock.calls[1] as unknown[])[1] as string;
    expect(secondCallMessage).toContain('CRITICAL: Your previous response was not valid JSON');
  });

  it('returns INVALID_LLM_RESPONSE after both attempts fail to parse', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'bad json', promptTokens: 3, completionTokens: 1 })
      .mockResolvedValueOnce({ text: 'still bad json', promptTokens: 3, completionTokens: 1 });

    const result = await runPropertyPopulationJsonStage({
      purpose: 'property_population',
      systemPrompt: 'system',
      message: 'msg',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
  });

  it('returns INVALID_LLM_RESPONSE when the LLM call throws', async () => {
    mockCallGemini.mockRejectedValueOnce(new Error('API failure'));

    const result = await runPropertyPopulationJsonStage({
      purpose: 'property_population',
      systemPrompt: 'system',
      message: 'msg',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(result.rawResponse).toContain('API failure');
  });

  it('filters returned values to allowedKeys when provided', async () => {
    const fullValues = { subject: 'Hello', body: 'World', extraField: 'should-be-dropped' };
    mockCallGemini.mockResolvedValueOnce(geminiResponse(fullValues));

    const result = await runPropertyPopulationJsonStage({
      purpose: 'property_population',
      systemPrompt: 'system',
      message: 'msg',
      allowedKeys: ['subject', 'body'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({ subject: 'Hello', body: 'World' });
    expect(result.values).not.toHaveProperty('extraField');
  });

  it('works with purpose field_directive_generation', async () => {
    const directiveValues = { subject: { directive: 'Use a concise subject line' } };
    mockCallGemini.mockResolvedValueOnce(geminiResponse(directiveValues));

    const result = await runPropertyPopulationJsonStage({
      purpose: 'field_directive_generation',
      systemPrompt: 'directive system prompt',
      message: 'directive message',
      correlationId: 'corr-directive',
      nodeId: 'node_1',
      nodeType: 'google_gmail',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual(directiveValues);
  });

  it('returns empty values object when LLM returns an empty JSON object', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiResponse({}));

    const result = await runPropertyPopulationJsonStage({
      purpose: 'property_population',
      systemPrompt: 'system',
      message: 'msg',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({});
  });

  it('returns all values when allowedKeys is an empty array', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiResponse(validValues));

    const result = await runPropertyPopulationJsonStage({
      purpose: 'property_population',
      systemPrompt: 'system',
      message: 'msg',
      allowedKeys: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual(validValues);
  });
});
