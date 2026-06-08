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
import { runNodeSelectionJsonStage } from '../node-selection-json';

const mockCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const validSelection = {
  selectedNodes: [
    {
      type: ' manual_trigger ',
      role: 'trigger',
      reason: 'Starts the workflow',
    },
    {
      type: ' google_gmail ',
      role: 'terminal',
      reason: 'User requested Gmail',
      nodeId: 'ignored_by_service',
    },
    {
      type: 'google_gmail',
      role: 'terminal',
      reason: 'Second branch also sends Gmail',
    },
  ],
};

describe('runNodeSelectionJsonStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns normalized parsed nodes from a fenced Gemini JSON response without assigning ids', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: `\`\`\`json\n${JSON.stringify(validSelection)}\n\`\`\``,
      promptTokens: 10,
      completionTokens: 20,
    });

    const result = await runNodeSelectionJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
      correlationId: 'corr-success',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selectedNodes).toEqual([
        { type: 'manual_trigger', role: 'trigger', reason: 'Starts the workflow' },
        { type: 'google_gmail', role: 'terminal', reason: 'User requested Gmail' },
        { type: 'google_gmail', role: 'terminal', reason: 'Second branch also sends Gmail' },
      ]);
      expect(result.selectedNodes[1]).not.toHaveProperty('nodeId');
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
        text: JSON.stringify(validSelection),
        promptTokens: 11,
        completionTokens: 21,
      });

    const result = await runNodeSelectionJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
    });

    expect(result.ok).toBe(true);
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    expect(mockCallGemini.mock.calls[1][0]).toContain('CRITICAL: Return ONLY valid JSON');
  });

  it('salvages complete selected nodes from a truncated response', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: `{"selectedNodes":[${JSON.stringify(validSelection.selectedNodes[0])},{"type":"cut"`,
      promptTokens: 6,
      completionTokens: 7,
    });

    const result = await runNodeSelectionJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selectedNodes).toHaveLength(1);
      expect(result.selectedNodes[0].type).toBe('manual_trigger');
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
        text: '{"selectedNodes":[]}',
        promptTokens: 4,
        completionTokens: 2,
      });

    const result = await runNodeSelectionJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_LLM_RESPONSE');
      expect(result.rawResponse).toBe('{"selectedNodes":[]}');
    }
  });
});
