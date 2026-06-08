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
import { runStructuralPromptStage } from '../structural-prompt';

const mockCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const intent = {
  intent: 'Send an email when triggered',
  triggerType: 'manual_trigger' as const,
  actions: ['send an email'],
  dataFlows: [],
  constraints: [],
  originalPrompt: 'Send an email when triggered',
};

const validBlueprint =
  'WORKFLOW: Route emails on trigger.\n\nTRIGGER: Manual Trigger - starts on demand.\n\nFLOW:\n1. Gmail - sends an email\n\nCONNECTIONS: Manual Trigger passes payload to Gmail.';

function geminiTextResponse(text: string) {
  return { text, promptTokens: 10, completionTokens: 20 };
}

describe('runStructuralPromptStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok: true with structuralPrompt and correct llmCall metadata on a valid LLM response', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiTextResponse(validBlueprint));

    const result = await runStructuralPromptStage(intent, '[]', 'corr-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structuralPrompt).toBe(validBlueprint.trim());
    expect(result.llmCall.model).toBe('gemini-3.5-flash');
    expect(result.llmCall.temperature).toBe(0.2);
    expect(result.llmCall.promptTokens).toBe(10);
    expect(result.llmCall.completionTokens).toBe(20);
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('returns ok: false with INVALID_LLM_RESPONSE when the LLM throws', async () => {
    mockCallGemini.mockRejectedValueOnce(new Error('network failure'));

    const result = await runStructuralPromptStage(intent, '[]', 'corr-throw');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(result.rawResponse).toContain('network failure');
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('retries on empty text and returns ok: true when retry succeeds', async () => {
    mockCallGemini
      .mockResolvedValueOnce(geminiTextResponse(''))
      .mockResolvedValueOnce(geminiTextResponse(validBlueprint));

    const result = await runStructuralPromptStage(intent, '[]');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structuralPrompt).toBe(validBlueprint.trim());
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    const retrySystemPrompt = (mockCallGemini.mock.calls[1] as unknown[])[0] as string;
    expect(retrySystemPrompt).toContain('CRITICAL: You MUST return the workflow blueprint');
  });

  it('returns ok: false with INVALID_LLM_RESPONSE when retry throws after empty first response', async () => {
    mockCallGemini
      .mockResolvedValueOnce(geminiTextResponse(''))
      .mockRejectedValueOnce(new Error('retry failure'));

    const result = await runStructuralPromptStage(intent, '[]');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(result.rawResponse).toContain('retry failure');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });

  it('returns ok: false with INVALID_LLM_RESPONSE when both first and retry return empty text', async () => {
    mockCallGemini
      .mockResolvedValueOnce(geminiTextResponse(''))
      .mockResolvedValueOnce(geminiTextResponse(''));

    const result = await runStructuralPromptStage(intent, '[]');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });
});
