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
  buildEdgeReasoningPrompt: jest.fn(() => ({ systemPrompt: 'EDGE_SYSTEM_PROMPT' })),
}));

import { callGemini } from '../../lib/gemini';
import { runEdgeReasoningStage } from '../edge-reasoning';

const mockCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const selectedNodes = [
  { nodeId: 'node_manual_trigger_1', type: 'manual_trigger', role: 'trigger' as const, reason: 'test' },
  { nodeId: 'node_google_gmail_1', type: 'google_gmail', role: 'action' as const, reason: 'test' },
];

const validReasoning = {
  orderedNodes: ['node_manual_trigger_1', 'node_google_gmail_1'],
  edges: [{ source: 'node_manual_trigger_1', target: 'node_google_gmail_1', type: 'main' }],
};

const cyclicReasoning = {
  orderedNodes: ['node_manual_trigger_1', 'node_google_gmail_1'],
  edges: [
    { source: 'node_manual_trigger_1', target: 'node_google_gmail_1', type: 'main' },
    { source: 'node_google_gmail_1', target: 'node_manual_trigger_1', type: 'main' },
  ],
};

function geminiResponse(payload: unknown) {
  return { text: JSON.stringify(payload), promptTokens: 10, completionTokens: 20 };
}

describe('runEdgeReasoningStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok:true with correct workflow and llmCall metadata on a valid LLM response', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiResponse(validReasoning));

    const result = await runEdgeReasoningStage(
      selectedNodes,
      '[]',
      'Send email when triggered',
      'corr-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orderedNodeIds).toEqual(validReasoning.orderedNodes);
    expect(result.edges).toEqual(validReasoning.edges);
    expect(result.workflow.nodes).toHaveLength(2);
    expect(result.workflow.edges).toHaveLength(1);
    expect(result.llmCall.model).toBe('gemini-3.5-flash');
    expect(result.llmCall.temperature).toBe(0.1);
    expect(result.llmCall.promptTokens).toBe(10);
    expect(result.llmCall.completionTokens).toBe(20);
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false INVALID_LLM_RESPONSE when the LLM throws', async () => {
    mockCallGemini.mockRejectedValueOnce(new Error('network failure'));

    const result = await runEdgeReasoningStage(selectedNodes, '[]', 'intent', 'corr-throw');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(result.rawResponse).toContain('network failure');
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('retries on parse failure and returns ok:true when retry succeeds', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'not valid json at all', promptTokens: 10, completionTokens: 5 })
      .mockResolvedValueOnce(geminiResponse(validReasoning));

    const result = await runEdgeReasoningStage(selectedNodes, '[]', 'intent');

    expect(result.ok).toBe(true);
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    const retrySystemPrompt = (mockCallGemini.mock.calls[1] as unknown[])[0] as string;
    expect(retrySystemPrompt).toContain('CRITICAL');
  });

  it('returns ok:false INVALID_LLM_RESPONSE when retry throws after parse failure', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'bad json', promptTokens: 5, completionTokens: 5 })
      .mockRejectedValueOnce(new Error('retry failure'));

    const result = await runEdgeReasoningStage(selectedNodes, '[]', 'intent');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(result.rawResponse).toContain('retry failure');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });

  it('returns ok:false INVALID_LLM_RESPONSE when both attempts fail to parse', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'bad json 1', promptTokens: 5, completionTokens: 5 })
      .mockResolvedValueOnce({ text: 'bad json 2', promptTokens: 5, completionTokens: 5 });

    const result = await runEdgeReasoningStage(selectedNodes, '[]', 'intent');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });

  it('detects a cycle, reprompts, and returns ok:true when cycle is resolved', async () => {
    mockCallGemini
      .mockResolvedValueOnce(geminiResponse(cyclicReasoning))
      .mockResolvedValueOnce(geminiResponse(validReasoning));

    const result = await runEdgeReasoningStage(selectedNodes, '[]', 'intent');

    expect(result.ok).toBe(true);
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
    if (!result.ok) return;
    expect(result.edges).toHaveLength(1);
  });

  it('returns ok:false CYCLE_DETECTED when cycle persists after reprompt', async () => {
    mockCallGemini
      .mockResolvedValueOnce(geminiResponse(cyclicReasoning))
      .mockResolvedValueOnce(geminiResponse(cyclicReasoning));

    const result = await runEdgeReasoningStage(selectedNodes, '[]', 'intent');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CYCLE_DETECTED');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });
});
