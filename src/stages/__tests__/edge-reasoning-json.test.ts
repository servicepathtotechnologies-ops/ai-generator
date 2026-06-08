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
import { runEdgeReasoningJsonStage } from '../edge-reasoning-json';

const mockCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const validReasoning = {
  orderedNodes: ['node_manual_trigger_1', 'node_google_gmail_1'],
  edges: [{ source: 'node_manual_trigger_1', target: 'node_google_gmail_1', type: 'main' }],
};

function geminiResponse(payload: unknown) {
  return {
    text: JSON.stringify(payload),
    promptTokens: 10,
    completionTokens: 20,
  };
}

describe('runEdgeReasoningJsonStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns orderedNodes and edges from a valid LLM response', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiResponse(validReasoning));

    const result = await runEdgeReasoningJsonStage({
      systemPrompt: 'system prompt',
      message: 'user message',
      correlationId: 'corr-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orderedNodes).toEqual(validReasoning.orderedNodes);
    expect(result.edges).toEqual(validReasoning.edges);
    expect(result.llmCall.model).toBe('gemini-3.5-flash');
    expect(result.llmCall.promptTokens).toBe(10);
    expect(result.llmCall.completionTokens).toBe(20);
  });

  it('strips markdown fences from the response', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: `\`\`\`json\n${JSON.stringify(validReasoning)}\n\`\`\``,
      promptTokens: 5,
      completionTokens: 15,
    });

    const result = await runEdgeReasoningJsonStage({
      systemPrompt: 'system',
      message: 'msg',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orderedNodes).toEqual(validReasoning.orderedNodes);
    expect(result.edges).toEqual(validReasoning.edges);
  });

  it('deduplicates orderedNodes returned by the LLM', async () => {
    const withDuplicates = {
      orderedNodes: ['node_a', 'node_b', 'node_a'],
      edges: [{ source: 'node_a', target: 'node_b', type: 'main' }],
    };
    mockCallGemini.mockResolvedValueOnce(geminiResponse(withDuplicates));

    const result = await runEdgeReasoningJsonStage({ systemPrompt: 's', message: 'm' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orderedNodes).toEqual(['node_a', 'node_b']);
  });

  it('retries on parse failure and succeeds on second attempt', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'not valid json at all', promptTokens: 10, completionTokens: 5 })
      .mockResolvedValueOnce(geminiResponse(validReasoning));

    const result = await runEdgeReasoningJsonStage({ systemPrompt: 's', message: 'm' });

    expect(result.ok).toBe(true);
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });

  it('returns INVALID_LLM_RESPONSE when both attempts fail to parse', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'bad', promptTokens: 1, completionTokens: 1 })
      .mockResolvedValueOnce({ text: 'still bad', promptTokens: 1, completionTokens: 1 });

    const result = await runEdgeReasoningJsonStage({ systemPrompt: 's', message: 'm' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
  });

  it('detects a cycle and retries with a corrective prompt, succeeds on cycle reprompt', async () => {
    const cyclic = {
      orderedNodes: ['a', 'b'],
      edges: [
        { source: 'a', target: 'b', type: 'main' },
        { source: 'b', target: 'a', type: 'main' },
      ],
    };
    mockCallGemini
      .mockResolvedValueOnce(geminiResponse(cyclic))
      .mockResolvedValueOnce(geminiResponse(validReasoning));

    const result = await runEdgeReasoningJsonStage({ systemPrompt: 's', message: 'm' });

    expect(result.ok).toBe(true);
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    if (!result.ok) return;
    expect(result.orderedNodes).toEqual(validReasoning.orderedNodes);
  });

  it('returns CYCLE_DETECTED when cycle persists after reprompt', async () => {
    const cyclic = {
      orderedNodes: ['a', 'b'],
      edges: [
        { source: 'a', target: 'b', type: 'main' },
        { source: 'b', target: 'a', type: 'main' },
      ],
    };
    mockCallGemini
      .mockResolvedValueOnce(geminiResponse(cyclic))
      .mockResolvedValueOnce(geminiResponse(cyclic));

    const result = await runEdgeReasoningJsonStage({ systemPrompt: 's', message: 'm' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CYCLE_DETECTED');
  });

  it('returns INVALID_LLM_RESPONSE when the LLM call throws', async () => {
    mockCallGemini.mockRejectedValueOnce(new Error('API failure'));

    const result = await runEdgeReasoningJsonStage({ systemPrompt: 's', message: 'm' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(result.rawResponse).toContain('API failure');
  });

  it('omits edges with missing source/target/type', async () => {
    const withBadEdges = {
      orderedNodes: ['a', 'b'],
      edges: [
        { source: 'a', target: 'b', type: 'main' },
        { source: 'a', target: '', type: 'main' },
        { source: '', target: 'b', type: 'main' },
        { source: 'a', target: 'b', type: '' },
      ],
    };
    mockCallGemini.mockResolvedValueOnce(geminiResponse(withBadEdges));

    const result = await runEdgeReasoningJsonStage({ systemPrompt: 's', message: 'm' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ source: 'a', target: 'b', type: 'main' });
  });
});
