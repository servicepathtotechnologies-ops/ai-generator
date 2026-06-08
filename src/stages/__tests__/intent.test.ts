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

jest.mock('../../lib/system-prompt-builder', () => ({
  buildIntentPrompt: jest.fn(() => ({ systemPrompt: 'INTENT_SYSTEM_PROMPT' })),
}));

import { callGemini } from '../../lib/gemini';
import { runIntentStage } from '../intent';

const mockCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const validIntent = {
  intent: 'Send an email when triggered',
  triggerType: 'manual_trigger',
  actions: ['send an email'],
  dataFlows: [],
  constraints: [],
};

function geminiResponse(payload: unknown) {
  return {
    text: JSON.stringify(payload),
    promptTokens: 10,
    completionTokens: 20,
  };
}

describe('runIntentStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok: true with parsed intent and correct llmCall metadata on a valid LLM response', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiResponse(validIntent));

    const result = await runIntentStage('Send an email when triggered', '[]', 'corr-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.intent).toBe('Send an email when triggered');
    expect(result.intent.triggerType).toBe('manual_trigger');
    expect(result.intent.actions).toEqual(['send an email']);
    expect(result.intent.originalPrompt).toBe('Send an email when triggered');
    expect(result.llmCall.model).toBe('gemini-3.5-flash');
    expect(result.llmCall.temperature).toBe(0.1);
    expect(result.llmCall.promptTokens).toBe(10);
    expect(result.llmCall.completionTokens).toBe(20);
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('returns ok: true with fallback: true when the LLM throws on first call', async () => {
    mockCallGemini.mockRejectedValueOnce(new Error('network failure'));

    const result = await runIntentStage('Send an email when triggered', '[]', 'corr-throw');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fallback).toBe(true);
    expect(result.intent.originalPrompt).toBe('Send an email when triggered');
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('retries on parse failure and returns ok: true when second attempt succeeds', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'not valid json at all', promptTokens: 5, completionTokens: 3 })
      .mockResolvedValueOnce(geminiResponse(validIntent));

    const result = await runIntentStage('Send an email when triggered', '[]');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.triggerType).toBe('manual_trigger');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    // Second call must include the JSON retry hint
    const secondCallSystemPrompt = (mockCallGemini.mock.calls[1] as unknown[])[0] as string;
    expect(secondCallSystemPrompt).toContain('CRITICAL: Your previous response was not valid JSON');
  });

  it('returns ok: false with INVALID_LLM_RESPONSE when both attempts return unparseable text', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'bad response', promptTokens: 3, completionTokens: 1 })
      .mockResolvedValueOnce({ text: 'still bad', promptTokens: 3, completionTokens: 1 });

    const result = await runIntentStage('Send an email when triggered', '[]');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });

  it('returns ok: false with INVALID_LLM_RESPONSE when the retry LLM call throws', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'bad json', promptTokens: 3, completionTokens: 1 })
      .mockRejectedValueOnce(new Error('retry network failure'));

    const result = await runIntentStage('Send an email when triggered', '[]');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(result.rawResponse).toContain('retry network failure');
  });

  it('strips markdown fences from the LLM response before parsing', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: `\`\`\`json\n${JSON.stringify(validIntent)}\n\`\`\``,
      promptTokens: 8,
      completionTokens: 12,
    });

    const result = await runIntentStage('Send an email when triggered', '[]');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.triggerType).toBe('manual_trigger');
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('always sets originalPrompt to the input userPrompt regardless of what the LLM returns', async () => {
    const intentWithDifferentPrompt = { ...validIntent, originalPrompt: 'LLM invented prompt' };
    mockCallGemini.mockResolvedValueOnce(geminiResponse(intentWithDifferentPrompt));

    const result = await runIntentStage('My real user prompt', '[]');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.originalPrompt).toBe('My real user prompt');
  });
});
