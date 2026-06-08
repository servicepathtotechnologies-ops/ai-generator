import { Router, Request, Response } from 'express';
import { runIntentStage } from '../stages/intent';
import { runCapabilitySelectionJsonStage } from '../stages/capability-selection-json';
import { runStructuralPromptStage, type StructuralPromptConstraints } from '../stages/structural-prompt';
import { runNodeSelectionJsonStage } from '../stages/node-selection-json';
import { runEdgeReasoningJsonStage } from '../stages/edge-reasoning-json';
import { runEdgeReasoningStage } from '../stages/edge-reasoning';
import { runValidationLlmStage, type Workflow } from '../stages/validation';
import {
  runPropertyPopulationJsonStage,
  type PropertyPopulationJsonPurpose,
} from '../stages/property-population';
import type { StructuredIntent } from '../stages/intent';
import type { ProposedEdge, SelectedNode } from '../lib/system-prompt-builder';
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
 * POST /generate/capability-selection-json
 *
 * Body:
 *   systemPrompt  - worker-built capability-selection prompt (required)
 *   message       - worker-built user message (required)
 *   correlationId - forwarded for structured log correlation (optional)
 *
 * Response: parsed capability steps from the LLM. The worker keeps registry
 * reconciliation, destination coverage repair, deterministic fallback, and
 * all capability-selection policy decisions locally.
 */
router.post('/capability-selection-json', async (req: Request, res: Response): Promise<void> => {
  const { systemPrompt, message, correlationId } = req.body as {
    systemPrompt?: string;
    message?: string;
    correlationId?: string;
  };

  if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    res.status(400).json({ error: 'systemPrompt is required', ref: req.requestId });
    return;
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required', ref: req.requestId });
    return;
  }

  const result = await runCapabilitySelectionJsonStage({
    systemPrompt: systemPrompt.trim(),
    message,
    correlationId,
  });
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
 * POST /generate/node-selection-json
 *
 * Body:
 *   systemPrompt  - worker-built node-selection prompt (required)
 *   message       - worker-built user message (required)
 *   correlationId - forwarded for structured log correlation (optional)
 *
 * Response: parsed selected node JSON from the LLM. The worker keeps registry
 * reconciliation, trigger injection, required-node repair, node-id assignment,
 * and all node-selection policy decisions locally.
 */
router.post('/node-selection-json', async (req: Request, res: Response): Promise<void> => {
  const { systemPrompt, message, correlationId } = req.body as {
    systemPrompt?: string;
    message?: string;
    correlationId?: string;
  };

  if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    res.status(400).json({ error: 'systemPrompt is required', ref: req.requestId });
    return;
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required', ref: req.requestId });
    return;
  }

  const result = await runNodeSelectionJsonStage({
    systemPrompt: systemPrompt.trim(),
    message,
    correlationId,
  });
  res.json(result);
});

/**
 * POST /generate/edge-reasoning-json
 *
 * Body:
 *   systemPrompt  - worker-built edge-reasoning prompt (required)
 *   message       - worker-built user message (required)
 *   correlationId - forwarded for structured log correlation (optional)
 *
 * Response: parsed orderedNodes + edges from the LLM (after cycle-detection retry).
 * The worker keeps: WorkflowNode building (real registry), seeded edge construction,
 * graph orchestrator initialization, switch-case extraction, and branch coverage logic.
 */
router.post('/edge-reasoning-json', async (req: Request, res: Response): Promise<void> => {
  const { systemPrompt, message, correlationId } = req.body as {
    systemPrompt?: string;
    message?: string;
    correlationId?: string;
  };

  if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    res.status(400).json({ error: 'systemPrompt is required', ref: req.requestId });
    return;
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required', ref: req.requestId });
    return;
  }

  const result = await runEdgeReasoningJsonStage({
    systemPrompt: systemPrompt.trim(),
    message,
    correlationId,
  });
  res.json(result);
});

/**
 * POST /generate/edge-reasoning
 *
 * Body:
 *   selectedNodes    - SelectedNode[] from node-selection stage (required)
 *   catalog          - pre-built node catalog string from the worker (optional)
 *   userIntent       - plain-text user intent (required)
 *   correlationId    - forwarded for structured log correlation (optional)
 *   structuralPrompt - workflow blueprint from structural-prompt stage (optional)
 *
 * Response: EdgeReasoningOutput (full stage result including workflow, orderedNodeIds, edges).
 * The worker may re-materialize using its own registry rather than using the returned workflow
 * directly.
 */
router.post('/edge-reasoning', async (req: Request, res: Response): Promise<void> => {
  const { selectedNodes, catalog, userIntent, correlationId, structuralPrompt } = req.body as {
    selectedNodes?: unknown;
    catalog?: string;
    userIntent?: string;
    correlationId?: string;
    structuralPrompt?: string;
  };

  const normalizedNodes = normalizeSelectedNodes(selectedNodes);
  if (!normalizedNodes || normalizedNodes.length === 0) {
    res.status(400).json({ error: 'selectedNodes is required', ref: req.requestId });
    return;
  }

  if (!userIntent || typeof userIntent !== 'string' || !userIntent.trim()) {
    res.status(400).json({ error: 'userIntent is required', ref: req.requestId });
    return;
  }

  const nodeCatalog = typeof catalog === 'string' ? catalog : '';
  const result = await runEdgeReasoningStage(
    normalizedNodes,
    nodeCatalog,
    userIntent.trim(),
    correlationId,
    typeof structuralPrompt === 'string' ? structuralPrompt : undefined,
  );
  res.json(result);
});

/**
 * POST /generate/validation
 *
 * Body:
 *   intent           - StructuredIntent or raw user intent string (required)
 *   catalog          - pre-built node catalog string from the worker (optional;
 *                      falls back to fetching /api/nodes/catalog from the worker)
 *   correlationId    - forwarded for structured log correlation (optional)
 *   workflow         - assembled workflow graph to validate (required)
 *   selectedNodes    - node-selection output used by validation prompt context (optional)
 *   proposedEdges    - edge-reasoning output used by validation prompt context (optional)
 *   structuralPrompt - workflow blueprint from structural-prompt stage (optional)
 *
 * Response: ValidationLlmOutput. The worker keeps structural validation locally.
 */
router.post('/validation', async (req: Request, res: Response): Promise<void> => {
  const { intent, catalog, correlationId, workflow, selectedNodes, proposedEdges, structuralPrompt } = req.body as {
    intent?: StructuredIntent | string;
    catalog?: string;
    correlationId?: string;
    workflow?: unknown;
    selectedNodes?: unknown;
    proposedEdges?: unknown;
    structuralPrompt?: string;
  };

  const userIntent = normalizeIntentText(intent);
  if (!userIntent) {
    res.status(400).json({ error: 'intent is required', ref: req.requestId });
    return;
  }

  const normalizedWorkflow = normalizeWorkflow(workflow);
  if (!normalizedWorkflow) {
    res.status(400).json({ error: 'workflow.nodes is required', ref: req.requestId });
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

  const result = await runValidationLlmStage(
    normalizedWorkflow,
    nodeCatalog,
    userIntent,
    normalizeSelectedNodes(selectedNodes),
    normalizeProposedEdges(proposedEdges),
    correlationId,
    typeof structuralPrompt === 'string' ? structuralPrompt : undefined,
  );
  res.json(result);
});

/**
 * POST /generate/property-population
 *
 * Body:
 *   purpose       - property_population or field_directive_generation (optional)
 *   systemPrompt  - worker-built system prompt (required)
 *   message       - worker-built user message (required)
 *   allowedKeys   - field keys to retain from the JSON object (optional)
 *   correlationId - forwarded for structured log correlation (optional)
 *   nodeId/nodeType - forwarded for structured log context (optional)
 *
 * Response: parsed JSON object from the LLM. The worker keeps registry/default
 * ownership decisions and all workflow mutation locally.
 */
router.post('/property-population', async (req: Request, res: Response): Promise<void> => {
  const { systemPrompt, message, correlationId, nodeId, nodeType } = req.body as {
    systemPrompt?: string;
    message?: string;
    correlationId?: string;
    nodeId?: string;
    nodeType?: string;
  };

  if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    res.status(400).json({ error: 'systemPrompt is required', ref: req.requestId });
    return;
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required', ref: req.requestId });
    return;
  }

  const purpose = normalizePropertyPopulationPurpose(req.body?.purpose);
  if (!purpose) {
    res.status(400).json({ error: 'purpose must be property_population or field_directive_generation', ref: req.requestId });
    return;
  }

  const result = await runPropertyPopulationJsonStage({
    purpose,
    systemPrompt: systemPrompt.trim(),
    message,
    allowedKeys: normalizeStringArray(req.body?.allowedKeys),
    correlationId,
    nodeId: typeof nodeId === 'string' ? nodeId : undefined,
    nodeType: typeof nodeType === 'string' ? nodeType : undefined,
  });
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

function normalizeProposedEdges(value: unknown): ProposedEdge[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const edges: ProposedEdge[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const source = String(item.source || '').trim();
    const target = String(item.target || '').trim();
    const type = String(item.type || '').trim();
    if (!source || !target || !type) continue;
    edges.push({ source, target, type });
  }

  return edges.length > 0 ? edges : undefined;
}

function normalizeWorkflow(value: unknown): Workflow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) return undefined;

  return {
    nodes: obj.nodes as Workflow['nodes'],
    edges: Array.isArray(obj.edges) ? obj.edges as Workflow['edges'] : [],
    metadata: obj.metadata,
  };
}

function normalizePropertyPopulationPurpose(value: unknown): PropertyPopulationJsonPurpose | undefined {
  if (value === undefined || value === null || value === '') return 'property_population';
  if (value === 'property_population' || value === 'field_directive_generation') return value;
  return undefined;
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
