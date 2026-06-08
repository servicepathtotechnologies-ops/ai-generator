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
import { runCapabilitySelectionJsonStage } from '../capability-selection-json';

const mockCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const validSteps = {
  steps: [
    {
      stepId: 'trigger',
      stepText: 'Manual trigger',
      intentClass: 'trigger',
      candidateNodeTypes: ['manual_trigger'],
      defaultSuggestedNodeType: 'manual_trigger',
      selectionPolicy: { multiSelectAllowed: false, required: true },
      confidence: 1.2,
    },
    {
      stepId: 'action_1',
      stepText: 'Send via Gmail',
      intentClass: 'communication',
      candidateNodeTypes: [' google_gmail ', ''],
      defaultSuggestedNodeType: ' google_gmail ',
      selectionPolicy: { multiSelectAllowed: false, required: true },
      ambiguous: true,
      reason: 'User explicitly requested Gmail',
    },
  ],
};

describe('runCapabilitySelectionJsonStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns normalized parsed steps from a fenced Gemini JSON response', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: `\`\`\`json\n${JSON.stringify(validSteps)}\n\`\`\``,
      promptTokens: 10,
      completionTokens: 20,
    });

    const result = await runCapabilitySelectionJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
      correlationId: 'corr-success',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].confidence).toBe(1);
      expect(result.steps[1]).toMatchObject({
        candidateNodeTypes: ['google_gmail'],
        defaultSuggestedNodeType: 'google_gmail',
        ambiguous: true,
        reason: 'User explicitly requested Gmail',
      });
      expect(result.llmCall).toEqual({
        model: 'gemini-3.5-flash',
        temperature: 0.1,
        promptTokens: 10,
        completionTokens: 20,
      });
    }
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('retries once when the first response cannot be parsed', async () => {
    mockCallGemini
      .mockResolvedValueOnce({
        text: 'not json',
        promptTokens: 3,
        completionTokens: 1,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(validSteps),
        promptTokens: 11,
        completionTokens: 21,
      });

    const result = await runCapabilitySelectionJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
    });

    expect(result.ok).toBe(true);
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    expect(mockCallGemini.mock.calls[1][0]).toContain('CRITICAL: Return ONLY valid JSON');
  });

  it('salvages complete steps from a truncated response', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: `{"steps":[${JSON.stringify(validSteps.steps[0])},{"stepId":"cut"`,
      promptTokens: 6,
      completionTokens: 7,
    });

    const result = await runCapabilitySelectionJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].stepId).toBe('trigger');
    }
  });

  it('returns INVALID_LLM_RESPONSE after retry parse failure', async () => {
    mockCallGemini
      .mockResolvedValueOnce({
        text: 'not json',
        promptTokens: 3,
        completionTokens: 1,
      })
      .mockResolvedValueOnce({
        text: '{"steps":[]}',
        promptTokens: 4,
        completionTokens: 2,
      });

    const result = await runCapabilitySelectionJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_LLM_RESPONSE');
      expect(result.rawResponse).toBe('{"steps":[]}');
    }
  });
});
