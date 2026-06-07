import { Router, Request, Response } from 'express';
import { runIntentStage } from '../stages/intent';
import { runCapabilitySelectionStage } from '../stages/capability-selection';
import { runStructuralPromptStage, type StructuralPromptConstraints } from '../stages/structural-prompt';
import { runNodeSelectionStage, type NodeSelectionConstraints } from '../stages/node-selection';
import { runEdgeReasoningStage } from '../stages/edge-reasoning';
import type { StructuredIntent } from '../stages/intent';
import type { SelectedNode } from '../lib/system-prompt-builder';
import { getNodeCatalog } from '../lib/catalog';

const router = Router();

/**
 * POST /generate/intent
 *
 * Body:
 *   prompt      — the raw user prompt (required)
 *   catalog     — pre-built node catalog string from the worker (optional;
 *                 falls back to fetching /api/nodes/catalog from the worker)
 *   correlationId — forwarded for structured log correlation (optional)
 *
 * Response: IntentStageOutput (same shape as worker's intent-stage result)
 */
router.post('/intent', async (req: Request, res: Response): Promise<void> => {
  const { prompt, catalog, correlationId } = req.body as {
    prompt?: string;
    catalog?: string;
    correlationId?: string;
  };

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt is required', ref: req.requestId });
    return;
  }

  let nodeCatalog: string;
  try {
    nodeCatalog = (typeof catalog === 'string' && catalog.length > 0)
      ? catalog
      : await getNodeCatalog();
  } catch (err) {
    res.status(503).json({ error: 'Node catalog unavailable', detail: String(err), ref: req.requestId });
    return;
  }

  const result = await runIntentStage(prompt.trim(), nodeCatalog, correlationId);
  res.json(result);
});

/**
 * POST /generate/capabilities
 *
 * Body:
 *   intent        — StructuredIntent from the intent stage (required)
 *   catalog       — pre-built node catalog string from the worker (optional;
 *                   falls back to fetching /api/nodes/catalog from the worker)
 *   correlationId — forwarded for structured log correlation (optional)
 *
 * Response: CapabilitySelectionOutput (same shape as worker's capability stage)
 */
router.post('/capabilities', async (req: Request, res: Response): Promise<void> => {
  const { intent, catalog, correlationId } = req.body as {
    intent?: StructuredIntent;
    catalog?: string;
    correlationId?: string;
  };

  if (!isStructuredIntent(intent)) {
    res.status(400).json({ error: 'intent is required', ref: req.requestId });
    return;
  }

  let nodeCatalog: string;
  try {
    nodeCatalog = (typeof catalog === 'string' && catalog.length > 0)
      ? catalog
      : await getNodeCatalog();
  } catch (err) {
    res.status(503).json({ error: 'Node catalog unavailable', detail: String(err), ref: req.requestId });
    return;
  }

  const result = await runCapabilitySelectionStage(intent, nodeCatalog, correlationId);
  res.json(result);
});

/**
 * POST /generate/structural-prompt
 *
 * Body:
 *   intent               - StructuredIntent from the intent stage (required)
 *   selectedCapabilities - selected node constraints (optional)
 *   catalog              - pre-built node catalog string from the worker (optional)
 *   correlationId        - forwarded for structured log correlation (optional)
 *
 * Response: StructuralPromptOutput (same shape as worker's structural-prompt stage)
 */
router.post('/structural-prompt', async (req: Request, res: Response): Promise<void> => {
  const { intent, catalog, correlationId } = req.body as {
    intent?: StructuredIntent;
    catalog?: string;
    correlationId?: string;
  };

  if (!isStructuredIntent(intent)) {
    res.status(400).json({ error: 'intent is required', ref: req.requestId });
    return;
  }

  const constraints = normalizeStructuralPromptConstraints(req.body as Record<string, unknown>);
  const nodeCatalog = typeof catalog === 'string' ? catalog : '';
  const result = await runStructuralPromptStage(intent, nodeCatalog, correlationId, constraints);
  res.json(result);
});

/**
 * POST /generate/node-selection
 *
 * Body:
 *   intent           - StructuredIntent from the intent stage (required)
 *   catalog          - pre-built node catalog string from the worker (optional;
 *                      falls back to fetching /api/nodes/catalog from the worker)
 *   correlationId    - forwarded for structured log correlation (optional)
 *   structuralPrompt - workflow blueprint from structural-prompt stage (optional)
 *   constraints      - selected/required node constraints (optional)
 *
 * Response: NodeSelectionOutput (same shape as worker's node-selection stage)
 */
router.post('/node-selection', async (req: Request, res: Response): Promise<void> => {
  const { intent, catalog, correlationId, structuralPrompt } = req.body as {
    intent?: StructuredIntent;
    catalog?: string;
    correlationId?: string;
    structuralPrompt?: string;
  };

  if (!isStructuredIntent(intent)) {
    res.status(400).json({ error: 'intent is required', ref: req.requestId });
    return;
  }

  let nodeCatalog: string;
  try {
    nodeCatalog = (typeof catalog === 'string' && catalog.length > 0)
      ? catalog
      : await getNodeCatalog();
  } catch (err) {
    res.status(503).json({ error: 'Node catalog unavailable', detail: String(err), ref: req.requestId });
    return;
  }

  const constraints = normalizeNodeSelectionConstraints(req.body as Record<string, unknown>);
  const result = await runNodeSelectionStage(
    intent,
    nodeCatalog,
    correlationId,
    typeof structuralPrompt === 'string' ? structuralPrompt : undefined,
    constraints,
  );
  res.json(result);
});

/**
 * POST /generate/edge-reasoning
 *
 * Body:
 *   intent           - StructuredIntent or raw user intent string (required)
 *   catalog          - pre-built node catalog string from the worker (optional;
 *                      falls back to fetching /api/nodes/catalog from the worker)
 *   correlationId    - forwarded for structured log correlation (optional)
 *   selectedNodes    - node-selection output to order and connect (required)
 *   structuralPrompt - workflow blueprint from structural-prompt stage (optional)
 *
 * Response: EdgeReasoningOutput (same shape as worker's edge-reasoning stage)
 */
router.post('/edge-reasoning', async (req: Request, res: Response): Promise<void> => {
  const { intent, catalog, correlationId, selectedNodes, structuralPrompt } = req.body as {
    intent?: StructuredIntent | string;
    catalog?: string;
    correlationId?: string;
    selectedNodes?: unknown;
    structuralPrompt?: string;
  };

  const userIntent = normalizeIntentText(intent);
  if (!userIntent) {
    res.status(400).json({ error: 'intent is required', ref: req.requestId });
    return;
  }

  const normalizedSelectedNodes = normalizeSelectedNodes(selectedNodes);
  if (!normalizedSelectedNodes || normalizedSelectedNodes.length === 0) {
    res.status(400).json({ error: 'selectedNodes is required', ref: req.requestId });
    return;
  }

  let nodeCatalog: string;
  try {
    nodeCatalog = (typeof catalog === 'string' && catalog.length > 0)
      ? catalog
      : await getNodeCatalog();
  } catch (err) {
    res.status(503).json({ error: 'Node catalog unavailable', detail: String(err), ref: req.requestId });
    return;
  }

  const result = await runEdgeReasoningStage(
    normalizedSelectedNodes,
    nodeCatalog,
    userIntent,
    correlationId,
    typeof structuralPrompt === 'string' ? structuralPrompt : undefined,
  );
  res.json(result);
});

export default router;

function isStructuredIntent(value: unknown): value is StructuredIntent {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  const triggerType = String(obj.triggerType || '').trim();
  const validTriggers = new Set(['schedule', 'webhook', 'form', 'chat_trigger', 'manual_trigger']);
  return (
    typeof obj.intent === 'string' &&
    validTriggers.has(triggerType) &&
    Array.isArray(obj.actions) &&
    Array.isArray(obj.dataFlows) &&
    Array.isArray(obj.constraints) &&
    typeof obj.originalPrompt === 'string'
  );
}

function normalizeIntentText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const intent = typeof obj.intent === 'string' ? obj.intent.trim() : '';
  return intent.length > 0 ? intent : undefined;
}

function normalizeSelectedNodes(value: unknown): SelectedNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const validRoles = new Set<SelectedNode['role']>(['trigger', 'action', 'logic', 'terminal']);
  const nodes: SelectedNode[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const type = String(item.type || '').trim();
    const nodeId = String(item.nodeId || '').trim();
    const rawRole = String(item.role || '').trim() as SelectedNode['role'];
    const role = validRoles.has(rawRole) ? rawRole : 'action';
    const reason = String(item.reason || 'Selected by upstream node-selection stage').trim();
    if (!type || !nodeId) continue;
    nodes.push({ type, nodeId, role, reason });
  }

  return nodes.length > 0 ? nodes : undefined;
}

function normalizeStructuralPromptConstraints(body: Record<string, unknown>): StructuralPromptConstraints | undefined {
  let byStep = normalizeStringArrayRecord(body.selectedNodeConstraintsByStep);
  let flat = normalizeStringArray(body.selectedNodeConstraintsFlat);

  if ((!byStep || !flat) && body.selectedCapabilities !== undefined) {
    const selected = normalizeSelectedCapabilities(body.selectedCapabilities);
    byStep = byStep ?? selected.selectedNodeConstraintsByStep;
    flat = flat ?? selected.selectedNodeConstraintsFlat;
  }

  if (!flat && byStep) {
    flat = [...new Set(Object.values(byStep).flat())];
  }

  if (!byStep && !flat) return undefined;
  return {
    selectedNodeConstraintsByStep: byStep,
    selectedNodeConstraintsFlat: flat,
  };
}

function normalizeNodeSelectionConstraints(body: Record<string, unknown>): NodeSelectionConstraints | undefined {
  const nested = body.constraints && typeof body.constraints === 'object' && !Array.isArray(body.constraints)
    ? body.constraints as Record<string, unknown>
    : {};

  let byStep =
    normalizeStringArrayRecord(nested.selectedNodeConstraintsByStep) ??
    normalizeStringArrayRecord(body.selectedNodeConstraintsByStep);
  let flat =
    normalizeStringArray(nested.selectedNodeConstraintsFlat) ??
    normalizeStringArray(body.selectedNodeConstraintsFlat);
  const required =
    normalizeStringArray(nested.requiredNodeTypes) ??
    normalizeStringArray(body.requiredNodeTypes);

  if ((!byStep || !flat) && body.selectedCapabilities !== undefined) {
    const selected = normalizeSelectedCapabilities(body.selectedCapabilities);
    byStep = byStep ?? selected.selectedNodeConstraintsByStep;
    flat = flat ?? selected.selectedNodeConstraintsFlat;
  }

  if (!flat && byStep) {
    flat = [...new Set(Object.values(byStep).flat())];
  }

  if (!byStep && !flat && !required) return undefined;
  return {
    selectedNodeConstraintsByStep: byStep,
    selectedNodeConstraintsFlat: flat,
    requiredNodeTypes: required,
  };
}

function normalizeSelectedCapabilities(value: unknown): StructuralPromptConstraints {
  if (Array.isArray(value)) {
    const directFlat = normalizeStringArray(value);
    if (directFlat && directFlat.length > 0) return { selectedNodeConstraintsFlat: directFlat };

    const byStep: Record<string, string[]> = {};
    for (const [index, raw] of value.entries()) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const stepId = String(item.stepId || `step_${index + 1}`).trim();
      const nodeType = String(
        item.selectedNodeType ||
        item.defaultSuggestedNodeType ||
        item.nodeType ||
        item.type ||
        '',
      ).trim();
      if (stepId && nodeType) byStep[stepId] = [nodeType];
    }
    return Object.keys(byStep).length > 0
      ? { selectedNodeConstraintsByStep: byStep, selectedNodeConstraintsFlat: [...new Set(Object.values(byStep).flat())] }
      : {};
  }

  if (!value || typeof value !== 'object') return {};
  const obj = value as Record<string, unknown>;

  const explicitByStep =
    normalizeStringArrayRecord(obj.selectedNodeConstraintsByStep) ??
    normalizeStringArrayRecord(obj.byStep) ??
    normalizeStringArrayRecord(obj.capabilitySelectionsByStep);
  const explicitFlat =
    normalizeStringArray(obj.selectedNodeConstraintsFlat) ??
    normalizeStringArray(obj.flat) ??
    normalizeStringArray(obj.selectedNodeTypes);

  if (explicitByStep || explicitFlat) {
    return {
      selectedNodeConstraintsByStep: explicitByStep,
      selectedNodeConstraintsFlat: explicitFlat ?? (explicitByStep ? [...new Set(Object.values(explicitByStep).flat())] : undefined),
    };
  }

  const record = normalizeStringArrayRecord(obj);
  return record
    ? { selectedNodeConstraintsByStep: record, selectedNodeConstraintsFlat: [...new Set(Object.values(record).flat())] }
    : {};
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? [...new Set(normalized)] : [];
}

function normalizeStringArrayRecord(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeStringArray(raw);
    if (normalized && normalized.length > 0) out[key] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
