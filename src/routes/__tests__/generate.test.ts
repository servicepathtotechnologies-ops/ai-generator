import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { Application, Request, Response, NextFunction } from 'express';
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
jest.mock('../../lib/catalog', () => ({
  getNodeCatalog: jest.fn(),
}));

import generateRouter from '../generate';
import { runIntentStage } from '../../stages/intent';
import { runCapabilitySelectionJsonStage } from '../../stages/capability-selection-json';
import { runStructuralPromptStage } from '../../stages/structural-prompt';
import { runNodeSelectionJsonStage } from '../../stages/node-selection-json';
import { runEdgeReasoningJsonStage } from '../../stages/edge-reasoning-json';
import { runEdgeReasoningStage } from '../../stages/edge-reasoning';
import { runValidationLlmStage } from '../../stages/validation';
import { runPropertyPopulationJsonStage } from '../../stages/property-population';
import { getNodeCatalog } from '../../lib/catalog';

const mockRunIntentStage = runIntentStage as jest.MockedFunction<typeof runIntentStage>;
const mockRunCapabilitySelectionJsonStage = runCapabilitySelectionJsonStage as jest.MockedFunction<typeof runCapabilitySelectionJsonStage>;
const mockRunStructuralPromptStage = runStructuralPromptStage as jest.MockedFunction<typeof runStructuralPromptStage>;
const mockRunNodeSelectionJsonStage = runNodeSelectionJsonStage as jest.MockedFunction<typeof runNodeSelectionJsonStage>;
const mockRunEdgeReasoningJsonStage = runEdgeReasoningJsonStage as jest.MockedFunction<typeof runEdgeReasoningJsonStage>;
const mockRunEdgeReasoningStage = runEdgeReasoningStage as jest.MockedFunction<typeof runEdgeReasoningStage>;
const mockRunValidationLlmStage = runValidationLlmStage as jest.MockedFunction<typeof runValidationLlmStage>;
const mockRunPropertyPopulationJsonStage = runPropertyPopulationJsonStage as jest.MockedFunction<typeof runPropertyPopulationJsonStage>;
const mockGetNodeCatalog = getNodeCatalog as jest.MockedFunction<typeof getNodeCatalog>;

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

const app = buildApp();

const llmCall = { model: 'gemini-3.5-flash', temperature: 0.1, promptTokens: 10, completionTokens: 20 };

const validIntent = {
  intent: 'Send email when triggered',
  triggerType: 'manual_trigger' as const,
  actions: ['send email'],
  dataFlows: [],
  constraints: [],
  originalPrompt: 'Send email when triggered',
};

const minimalWorkflow = {
  nodes: [{ id: 'n1', type: 'manual_trigger', data: { label: 'Trigger', type: 'manual_trigger', category: 'trigger', config: {} } }],
  edges: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetNodeCatalog.mockResolvedValue('CATALOG_TEXT');
});

// ─── POST /generate/intent ────────────────────────────────────────────────────

describe('POST /generate/intent', () => {
  it('returns 400 when prompt is missing', async () => {
    const res = await request(app).post('/generate/intent').send({}).set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'prompt is required');
  });

  it('returns 503 when catalog fetch fails', async () => {
    mockGetNodeCatalog.mockRejectedValue(new Error('Worker unreachable'));
    const res = await request(app)
      .post('/generate/intent')
      .send({ prompt: 'send an email' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/catalog unavailable/i);
  });

  it('delegates to runIntentStage and returns its result', async () => {
    const stageResult = { ok: true as const, intent: validIntent, durationMs: 50, llmCall };
    mockRunIntentStage.mockResolvedValue(stageResult);

    const res = await request(app)
      .post('/generate/intent')
      .send({ prompt: 'send an email', correlationId: 'c1' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.intent.triggerType).toBe('manual_trigger');
    expect(mockRunIntentStage).toHaveBeenCalledWith('send an email', 'CATALOG_TEXT', 'c1');
  });

  it('uses provided catalog without re-fetching when present in body', async () => {
    const stageResult = { ok: true as const, intent: validIntent, durationMs: 50, llmCall };
    mockRunIntentStage.mockResolvedValue(stageResult);

    const res = await request(app)
      .post('/generate/intent')
      .send({ prompt: 'send an email', catalog: 'INLINE_CATALOG' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(mockGetNodeCatalog).not.toHaveBeenCalled();
    expect(mockRunIntentStage).toHaveBeenCalledWith('send an email', 'INLINE_CATALOG', undefined);
  });
});

// ─── POST /generate/capability-selection-json ─────────────────────────────────

describe('POST /generate/capability-selection-json', () => {
  it('returns 400 when systemPrompt is missing', async () => {
    const res = await request(app)
      .post('/generate/capability-selection-json')
      .send({ message: 'msg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/systemPrompt/);
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app)
      .post('/generate/capability-selection-json')
      .send({ systemPrompt: 'sys' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/);
  });

  it('delegates to runCapabilitySelectionJsonStage and returns its result', async () => {
    const stageResult = { ok: true as const, steps: [], durationMs: 11, llmCall };
    mockRunCapabilitySelectionJsonStage.mockResolvedValue(stageResult as any);

    const res = await request(app)
      .post('/generate/capability-selection-json')
      .send({ systemPrompt: 'sys', message: 'msg', correlationId: 'c2' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockRunCapabilitySelectionJsonStage).toHaveBeenCalledWith({
      systemPrompt: 'sys',
      message: 'msg',
      correlationId: 'c2',
    });
  });
});

// ─── POST /generate/structural-prompt ─────────────────────────────────────────

describe('POST /generate/structural-prompt', () => {
  it('returns 400 when intent is missing', async () => {
    const res = await request(app)
      .post('/generate/structural-prompt')
      .send({ catalog: 'cat' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/intent/i);
  });

  it('returns 400 when intent has invalid triggerType', async () => {
    const res = await request(app)
      .post('/generate/structural-prompt')
      .send({ intent: { ...validIntent, triggerType: 'unknown_trigger' } });
    expect(res.status).toBe(400);
  });

  it('delegates to runStructuralPromptStage and returns its result', async () => {
    const stageResult = { ok: true as const, structuralPrompt: 'BLUEPRINT', durationMs: 30, llmCall };
    mockRunStructuralPromptStage.mockResolvedValue(stageResult);

    const res = await request(app)
      .post('/generate/structural-prompt')
      .send({ intent: validIntent, catalog: 'CAT', correlationId: 'c3' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.structuralPrompt).toBe('BLUEPRINT');
    expect(mockRunStructuralPromptStage).toHaveBeenCalledWith(
      validIntent,
      'CAT',
      'c3',
      undefined,
    );
  });
});

// ─── POST /generate/node-selection-json ───────────────────────────────────────

describe('POST /generate/node-selection-json', () => {
  it('returns 400 when systemPrompt is missing', async () => {
    const res = await request(app)
      .post('/generate/node-selection-json')
      .send({ message: 'msg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/systemPrompt/);
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app)
      .post('/generate/node-selection-json')
      .send({ systemPrompt: 'sys' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/);
  });

  it('delegates to runNodeSelectionJsonStage and returns its result', async () => {
    const stageResult = { ok: true as const, selectedNodes: [], durationMs: 15, llmCall };
    mockRunNodeSelectionJsonStage.mockResolvedValue(stageResult as any);

    const res = await request(app)
      .post('/generate/node-selection-json')
      .send({ systemPrompt: 'sys', message: 'msg', correlationId: 'c4' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockRunNodeSelectionJsonStage).toHaveBeenCalledWith({
      systemPrompt: 'sys',
      message: 'msg',
      correlationId: 'c4',
    });
  });
});

// ─── POST /generate/edge-reasoning-json ───────────────────────────────────────

describe('POST /generate/edge-reasoning-json', () => {
  it('returns 400 when systemPrompt is missing', async () => {
    const res = await request(app)
      .post('/generate/edge-reasoning-json')
      .send({ message: 'msg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/systemPrompt/);
  });

  it('delegates to runEdgeReasoningJsonStage and returns its result', async () => {
    const stageResult = {
      ok: true as const,
      orderedNodeIds: ['n1', 'n2'],
      edges: [{ source: 'n1', target: 'n2', type: 'main' }],
      durationMs: 20,
      llmCall,
    };
    mockRunEdgeReasoningJsonStage.mockResolvedValue(stageResult as any);

    const res = await request(app)
      .post('/generate/edge-reasoning-json')
      .send({ systemPrompt: 'sys', message: 'msg', correlationId: 'c5' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orderedNodeIds).toEqual(['n1', 'n2']);
  });
});

// ─── POST /generate/edge-reasoning ────────────────────────────────────────────

describe('POST /generate/edge-reasoning', () => {
  const validSelectedNodes = [
    { type: 'manual_trigger', nodeId: 'node_1', role: 'trigger', reason: 'starts workflow' },
    { type: 'google_gmail', nodeId: 'node_2', role: 'terminal', reason: 'send email' },
  ];

  it('returns 400 when selectedNodes is missing', async () => {
    const res = await request(app)
      .post('/generate/edge-reasoning')
      .send({ userIntent: 'send email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/selectedNodes/);
  });

  it('returns 400 when selectedNodes array is empty', async () => {
    const res = await request(app)
      .post('/generate/edge-reasoning')
      .send({ selectedNodes: [], userIntent: 'send email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/selectedNodes/);
  });

  it('returns 400 when userIntent is missing', async () => {
    const res = await request(app)
      .post('/generate/edge-reasoning')
      .send({ selectedNodes: validSelectedNodes });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userIntent/);
  });

  it('delegates to runEdgeReasoningStage and returns its result', async () => {
    const stageResult = {
      ok: true as const,
      orderedNodeIds: ['node_1', 'node_2'],
      edges: [{ source: 'node_1', target: 'node_2', type: 'main' }],
      workflow: { nodes: [], edges: [] },
      durationMs: 25,
      llmCall,
    };
    mockRunEdgeReasoningStage.mockResolvedValue(stageResult as any);

    const res = await request(app)
      .post('/generate/edge-reasoning')
      .send({
        selectedNodes: validSelectedNodes,
        userIntent: 'send email when triggered',
        catalog: 'CAT',
        correlationId: 'c6',
        structuralPrompt: 'BLUEPRINT',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orderedNodeIds).toEqual(['node_1', 'node_2']);
    expect(mockRunEdgeReasoningStage).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'manual_trigger', nodeId: 'node_1' }),
      ]),
      'CAT',
      'send email when triggered',
      'c6',
      'BLUEPRINT',
    );
  });
});

// ─── POST /generate/validation ────────────────────────────────────────────────

describe('POST /generate/validation', () => {
  it('returns 400 when intent is missing', async () => {
    const res = await request(app)
      .post('/generate/validation')
      .send({ workflow: minimalWorkflow });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/intent/i);
  });

  it('returns 400 when workflow.nodes is missing', async () => {
    const res = await request(app)
      .post('/generate/validation')
      .send({ intent: validIntent, workflow: { nodes: [], edges: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workflow\.nodes/i);
  });

  it('returns 503 when catalog fetch fails', async () => {
    mockGetNodeCatalog.mockRejectedValue(new Error('Worker unreachable'));
    const res = await request(app)
      .post('/generate/validation')
      .send({ intent: validIntent, workflow: minimalWorkflow });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/catalog unavailable/i);
  });

  it('delegates to runValidationLlmStage with normalized inputs and returns result', async () => {
    const stageResult = { ok: true as const, status: 'pass' as const, issues: [], durationMs: 18, llmCall };
    mockRunValidationLlmStage.mockResolvedValue(stageResult as any);

    const res = await request(app)
      .post('/generate/validation')
      .send({
        intent: validIntent,
        workflow: minimalWorkflow,
        correlationId: 'c7',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('pass');
    expect(mockRunValidationLlmStage).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: minimalWorkflow.nodes }),
      'CATALOG_TEXT',
      'Send email when triggered',
      undefined,
      undefined,
      'c7',
      undefined,
    );
  });
});

// ─── POST /generate/property-population ───────────────────────────────────────

describe('POST /generate/property-population', () => {
  it('returns 400 when systemPrompt is missing', async () => {
    const res = await request(app)
      .post('/generate/property-population')
      .send({ message: 'msg', purpose: 'property_population' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/systemPrompt/);
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app)
      .post('/generate/property-population')
      .send({ systemPrompt: 'sys', purpose: 'property_population' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/);
  });

  it('returns 400 when purpose is an unrecognised value', async () => {
    const res = await request(app)
      .post('/generate/property-population')
      .send({ systemPrompt: 'sys', message: 'msg', purpose: 'bad_purpose' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/purpose/);
  });

  it('defaults purpose to property_population when omitted and delegates to stage', async () => {
    const stageResult = { ok: true as const, values: { field: 'value' }, durationMs: 12, llmCall };
    mockRunPropertyPopulationJsonStage.mockResolvedValue(stageResult as any);

    const res = await request(app)
      .post('/generate/property-population')
      .send({ systemPrompt: 'sys', message: 'msg', nodeId: 'n1', nodeType: 'gmail' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockRunPropertyPopulationJsonStage).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'property_population',
        systemPrompt: 'sys',
        message: 'msg',
        nodeId: 'n1',
        nodeType: 'gmail',
      }),
    );
  });

  it('passes field_directive_generation purpose through to stage', async () => {
    const stageResult = { ok: true as const, values: {}, durationMs: 8, llmCall };
    mockRunPropertyPopulationJsonStage.mockResolvedValue(stageResult as any);

    const res = await request(app)
      .post('/generate/property-population')
      .send({ systemPrompt: 'sys', message: 'msg', purpose: 'field_directive_generation' });

    expect(res.status).toBe(200);
    expect(mockRunPropertyPopulationJsonStage).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'field_directive_generation' }),
    );
  });
});
