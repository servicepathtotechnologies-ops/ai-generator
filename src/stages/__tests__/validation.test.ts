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
import { runValidationLlmStage } from '../validation';

const mockCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

const minimalWorkflow = {
  nodes: [
    { id: 'node_1', type: 'manual_trigger', data: { label: 'Trigger', type: 'manual_trigger', category: 'trigger', config: {} } },
    { id: 'node_2', type: 'google_gmail', data: { label: 'Gmail', type: 'google_gmail', category: 'communication', config: {} } },
  ],
  edges: [{ source: 'node_1', target: 'node_2', type: 'main' }],
};

function geminiResponse(payload: unknown) {
  return {
    text: JSON.stringify(payload),
    promptTokens: 10,
    completionTokens: 20,
  };
}

const passResult = { status: 'pass', issues: [] };
const failWithWarningResult = {
  status: 'fail',
  issues: [{ severity: 'warning', description: 'Missing optional field', suggestedFix: 'Add field' }],
};
const failWithErrorResult = {
  status: 'fail',
  issues: [{ severity: 'error', description: 'Missing required node', suggestedFix: 'Add trigger' }],
};

describe('runValidationLlmStage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok: true with status=pass and empty issues on a valid pass response', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiResponse(passResult));

    const result = await runValidationLlmStage(
      minimalWorkflow,
      '[]',
      'Send email when triggered',
      undefined,
      undefined,
      'corr-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('pass');
    expect(result.issues).toEqual([]);
    expect(result.llmCall.model).toBe('gemini-3.5-flash');
    expect(result.llmCall.promptTokens).toBe(10);
    expect(result.llmCall.completionTokens).toBe(20);
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('returns ok: true with status=fail and warning issues when there are no error-severity issues', async () => {
    mockCallGemini.mockResolvedValueOnce(geminiResponse(failWithWarningResult));

    const result = await runValidationLlmStage(
      minimalWorkflow,
      '[]',
      'Send email when triggered',
      undefined,
      undefined,
      'corr-warn',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('fail');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('warning');
    // No repair pass — only one LLM call
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('retries on parse failure and returns ok: true when second attempt succeeds', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'not valid json at all', promptTokens: 5, completionTokens: 3 })
      .mockResolvedValueOnce(geminiResponse(passResult));

    const result = await runValidationLlmStage(
      minimalWorkflow,
      '[]',
      'Send email when triggered',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('pass');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });

  it('returns ok: false with INVALID_LLM_RESPONSE when the LLM throws on the first call', async () => {
    mockCallGemini.mockRejectedValueOnce(new Error('network failure'));

    const result = await runValidationLlmStage(
      minimalWorkflow,
      '[]',
      'Send email when triggered',
      undefined,
      undefined,
      'corr-throw',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(result.rawResponse).toContain('network failure');
  });

  it('returns ok: false with INVALID_LLM_RESPONSE when both attempts return unparseable JSON', async () => {
    mockCallGemini
      .mockResolvedValueOnce({ text: 'bad', promptTokens: 1, completionTokens: 1 })
      .mockResolvedValueOnce({ text: 'still bad', promptTokens: 1, completionTokens: 1 });

    const result = await runValidationLlmStage(
      minimalWorkflow,
      '[]',
      'Send email when triggered',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_LLM_RESPONSE');
    expect(mockCallGemini).toHaveBeenCalledTimes(2);
  });

  it('triggers a repair pass and revalidation when status=fail has error-severity issues', async () => {
    // 1st call: validation → fail with error
    mockCallGemini.mockResolvedValueOnce(geminiResponse(failWithErrorResult));
    // 2nd call: repair → repaired graph JSON
    mockCallGemini.mockResolvedValueOnce(geminiResponse({
      nodes: minimalWorkflow.nodes,
      edges: minimalWorkflow.edges,
    }));
    // 3rd call: revalidate → pass
    mockCallGemini.mockResolvedValueOnce(geminiResponse(passResult));

    const result = await runValidationLlmStage(
      minimalWorkflow,
      '[]',
      'Send email when triggered',
      undefined,
      undefined,
      'corr-repair',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // After repair+revalidation the result reflects the revalidation pass
    expect(result.status).toBe('pass');
    // Three total LLM calls: validate → repair → revalidate
    expect(mockCallGemini).toHaveBeenCalledTimes(3);
  });

  it('strips markdown fences from the LLM response before parsing', async () => {
    mockCallGemini.mockResolvedValueOnce({
      text: `\`\`\`json\n${JSON.stringify(passResult)}\n\`\`\``,
      promptTokens: 8,
      completionTokens: 12,
    });

    const result = await runValidationLlmStage(
      minimalWorkflow,
      '[]',
      'Send email when triggered',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('pass');
  });
});
