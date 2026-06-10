import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { Application, NextFunction, Request, Response } from 'express';
import request from 'supertest';

jest.mock('../../stages/intent', () => ({ runIntentStage: jest.fn() }));
jest.mock('../../stages/capability-selection-json', () => ({
  runCapabilitySelectionJsonStage: jest.fn(),
}));
jest.mock('../../stages/structural-prompt', () => ({
  runStructuralPromptStage: jest.fn(),
}));
jest.mock('../../stages/node-selection-json', () => ({
  runNodeSelectionJsonStage: jest.fn(),
}));
jest.mock('../../stages/edge-reasoning-json', () => ({
  runEdgeReasoningJsonStage: jest.fn(),
}));
jest.mock('../../stages/edge-reasoning', () => ({
  runEdgeReasoningStage: jest.fn(),
}));
jest.mock('../../stages/validation', () => ({
  runValidationLlmStage: jest.fn(),
}));
jest.mock('../../stages/property-population', () => ({
  runPropertyPopulationJsonStage: jest.fn(),
}));
jest.mock('../../lib/catalog', () => ({ getNodeCatalog: jest.fn() }));

import generateRouter from '../generate';
import { runStructuralPromptStage } from '../../stages/structural-prompt';

const mockRunStructuralPromptStage = runStructuralPromptStage as jest.MockedFunction<typeof runStructuralPromptStage>;

const validIntent = {
  intent: 'Send an email and post a Slack update',
  triggerType: 'manual_trigger' as const,
  actions: ['send an email', 'post a Slack update'],
  dataFlows: [],
  constraints: [],
  originalPrompt: 'Send an email and post a Slack update',
};

function buildApp(): Application {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).requestId = 'test-req-id';
    next();
  });
  app.use(express.json());
  app.use('/generate', generateRouter);
  return app;
}

describe('POST /generate/structural-prompt constraints', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunStructuralPromptStage.mockResolvedValue({
      ok: true,
      structuralPrompt: 'WORKFLOW: Generated blueprint.',
      durationMs: 4,
      llmCall: {
        model: 'gemini-3.5-flash',
        temperature: 0.2,
        promptTokens: 10,
        completionTokens: 6,
      },
    });
  });

  it('normalizes selectedCapabilities into by-step and flat structural constraints', async () => {
    const res = await request(app)
      .post('/generate/structural-prompt')
      .send({
        intent: validIntent,
        catalog: 'CATALOG',
        correlationId: 'corr-constraints',
        selectedCapabilities: [
          { stepId: 'step_email', selectedNodeType: 'google_gmail' },
          { stepId: 'step_notify', defaultSuggestedNodeType: 'slack' },
          { nodeType: 'log_output' },
          { stepId: 'ignored', selectedNodeType: '   ' },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockRunStructuralPromptStage).toHaveBeenCalledWith(
      validIntent,
      'CATALOG',
      'corr-constraints',
      {
        selectedNodeConstraintsByStep: {
          step_email: ['google_gmail'],
          step_notify: ['slack'],
          step_3: ['log_output'],
        },
        selectedNodeConstraintsFlat: ['google_gmail', 'slack', 'log_output'],
      },
    );
  });

  it('derives flat constraints from explicit by-step constraints when flat constraints are absent', async () => {
    const res = await request(app)
      .post('/generate/structural-prompt')
      .send({
        intent: validIntent,
        selectedNodeConstraintsByStep: {
          step_email: ['google_gmail', 'google_gmail', '', '  '],
          step_notify: ['slack'],
        },
      });

    expect(res.status).toBe(200);
    expect(mockRunStructuralPromptStage).toHaveBeenCalledWith(
      validIntent,
      '',
      undefined,
      {
        selectedNodeConstraintsByStep: {
          step_email: ['google_gmail'],
          step_notify: ['slack'],
        },
        selectedNodeConstraintsFlat: ['google_gmail', 'slack'],
      },
    );
  });
});
