import { callGemini } from '../lib/gemini';
import { createCatalogRegistry } from '../lib/catalog-registry';
import { logger } from '../lib/logger';
import {
  buildEdgeReasoningPrompt,
  type ProposedEdge,
  type SelectedNode,
} from '../lib/system-prompt-builder';

export interface WorkflowNode {
  id: string;
  type: string;
  data: {
    label: string;
    type: string;
    category: string;
    config: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface Workflow {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  metadata?: unknown;
}

export interface EdgeReasoningResult {
  ok: true;
  workflow: Workflow;
  orderedNodeIds: string[];
  edges: ProposedEdge[];
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
}

export interface EdgeReasoningError {
  ok: false;
  code: 'CYCLE_DETECTED' | 'INVALID_LLM_RESPONSE';
  rawResponse: string;
  durationMs: number;
}

export type EdgeReasoningOutput = EdgeReasoningResult | EdgeReasoningError;

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;

export async function runEdgeReasoningStage(
  selectedNodes: SelectedNode[],
  catalog: string,
  userIntent: string,
  correlationId?: string,
  structuralPrompt?: string,
): Promise<EdgeReasoningOutput> {
  const startedAt = Date.now();

  logger.info({
    event: 'ai_pipeline_stage_start',
    stage: 'edge_reasoning',
    correlationId,
    inputSummary: `nodes=${selectedNodes.length}`,
  });

  const { systemPrompt } = buildEdgeReasoningPrompt(catalog, userIntent, { selectedNodes });
  const message = `SELECTED_NODES:\n${JSON.stringify(selectedNodes, null, 2)}\n\nUSER_INTENT:\n${userIntent}${structuralPrompt ? `\n\nWORKFLOW_BLUEPRINT:\n${structuralPrompt}` : ''}`;

  logger.info({
    event: 'ai_pipeline_llm_call',
    stage: 'edge_reasoning',
    correlationId,
    model: MODEL,
    temperature: TEMPERATURE,
  });

  let text = '';
  let promptTokens = Math.ceil((systemPrompt.length + message.length) / 4);
  let completionTokens = 0;

  try {
    const result = await callGemini(systemPrompt, message, MODEL, TEMPERATURE);
    text = result.text;
    promptTokens = result.promptTokens;
    completionTokens = result.completionTokens;
  } catch (error) {
    const rawResponse = error instanceof Error ? error.message : String(error);
    logger.error({
      event: 'ai_pipeline_stage_error',
      stage: 'edge_reasoning',
      correlationId,
      error: 'LLM_CALL_FAILED',
      message: rawResponse,
    });
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
  }

  let parsed = parseEdgeReasoning(text);

  if (!parsed) {
    logger.warn({
      event: 'ai_pipeline_stage_retry',
      stage: 'edge_reasoning',
      correlationId,
      reason: 'STRUCTURED_DECODE_FAILED',
    });

    try {
      const retryPrompt = `${systemPrompt}\n\nCRITICAL: Return ONLY valid JSON. No markdown, no explanation.`;
      const result = await callGemini(retryPrompt, message, MODEL, TEMPERATURE);
      text = result.text;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      parsed = parseEdgeReasoning(text);
    } catch (error) {
      const rawResponse = error instanceof Error ? error.message : String(error);
      logger.error({
        event: 'ai_pipeline_stage_error',
        stage: 'edge_reasoning',
        correlationId,
        error: 'LLM_RETRY_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
    }

    if (!parsed) {
      logger.error({
        event: 'ai_pipeline_stage_error',
        stage: 'edge_reasoning',
        correlationId,
        error: 'INVALID_LLM_RESPONSE',
        llmResponse: text,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: text, durationMs: Date.now() - startedAt };
    }
  }

  const cycleInfo = detectCycle(parsed.orderedNodes, parsed.edges);
  if (cycleInfo) {
    logger.warn({ event: 'ai_pipeline_cycle_detected', stage: 'edge_reasoning', correlationId, cycleInfo });

    const { systemPrompt: reprompt } = buildEdgeReasoningPrompt(catalog, userIntent, {
      selectedNodes,
      cycleInfo,
    });

    try {
      const result = await callGemini(reprompt, message, MODEL, TEMPERATURE);
      text = result.text;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
    } catch (error) {
      const rawResponse = error instanceof Error ? error.message : String(error);
      logger.error({
        event: 'ai_pipeline_stage_error',
        stage: 'edge_reasoning',
        correlationId,
        error: 'CYCLE_REPROMPT_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'CYCLE_DETECTED', rawResponse, durationMs: Date.now() - startedAt };
    }

    const reparsed = parseEdgeReasoning(text);
    if (!reparsed || detectCycle(reparsed.orderedNodes, reparsed.edges)) {
      logger.error({
        event: 'ai_pipeline_stage_error',
        stage: 'edge_reasoning',
        correlationId,
        error: 'CYCLE_DETECTED',
        llmResponse: text,
      });
      return { ok: false, code: 'CYCLE_DETECTED', rawResponse: text, durationMs: Date.now() - startedAt };
    }

    parsed = reparsed;
  }

  const materialized = materializeWorkflow(selectedNodes, parsed, catalog);
  const durationMs = Date.now() - startedAt;

  logger.info({
    event: 'ai_pipeline_stage_end',
    stage: 'edge_reasoning',
    correlationId,
    outputSummary: `nodes=${materialized.workflow.nodes.length}, edges=${materialized.workflow.edges.length}`,
    durationMs,
  });

  return {
    ok: true,
    workflow: materialized.workflow,
    orderedNodeIds: materialized.orderedNodeIds,
    edges: materialized.proposedEdges,
    durationMs,
    llmCall: {
      model: MODEL,
      temperature: TEMPERATURE,
      promptTokens,
      completionTokens: completionTokens || Math.ceil(text.length / 4),
    },
  };
}

interface ParsedEdgeReasoning {
  orderedNodes: string[];
  edges: ProposedEdge[];
}

function stripMarkdownFences(text: string): string {
  let cleaned = String(text || '').trim().replace(/^\uFEFF/, '').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = cleaned
      .replace(/^\s*```[a-z0-9_-]*\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function parseEdgeReasoning(input: unknown): ParsedEdgeReasoning | null {
  if (input && typeof input === 'object') {
    return validateEdgeReasoningObject(input);
  }
  if (typeof input !== 'string') return null;

  try {
    const cleaned = stripMarkdownFences(input);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(cleaned.substring(start, end + 1));
    return validateEdgeReasoningObject(obj);
  } catch {
    return null;
  }
}

function validateEdgeReasoningObject(obj: unknown): ParsedEdgeReasoning | null {
  if (!obj || typeof obj !== 'object') return null;
  const raw = obj as Record<string, unknown>;
  if (!Array.isArray(raw.orderedNodes) || !Array.isArray(raw.edges)) return null;

  const seenOrdered = new Set<string>();
  const orderedNodes: string[] = [];
  for (const id of raw.orderedNodes) {
    const nodeId = String(id || '').trim();
    if (!nodeId || seenOrdered.has(nodeId)) continue;
    seenOrdered.add(nodeId);
    orderedNodes.push(nodeId);
  }

  const edges: ProposedEdge[] = [];
  for (const edge of raw.edges) {
    if (!edge || typeof edge !== 'object') continue;
    const e = edge as Record<string, unknown>;
    const source = String(e.source || '').trim();
    const target = String(e.target || '').trim();
    const type = String(e.type || '').trim();
    if (!source || !target || !type) continue;
    edges.push({ source, target, type });
  }

  return orderedNodes.length > 0 ? { orderedNodes, edges } : null;
}

function detectCycle(nodeIds: string[], edges: ProposedEdge[]): string | null {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const edge of edges) {
    const targets = adj.get(edge.source) ?? [];
    targets.push(edge.target);
    adj.set(edge.source, targets);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string | null {
    if (stack.has(node)) return [...path, node].join(' -> ');
    if (visited.has(node)) return null;
    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      const cycle = dfs(neighbor);
      if (cycle) return cycle;
    }

    path.pop();
    stack.delete(node);
    return null;
  }

  for (const id of nodeIds) {
    if (!visited.has(id)) {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }

  return null;
}

function materializeWorkflow(
  selectedNodes: SelectedNode[],
  parsed: ParsedEdgeReasoning,
  catalog: string,
): { workflow: Workflow; orderedNodeIds: string[]; proposedEdges: ProposedEdge[] } {
  const registry = createCatalogRegistry(catalog);
  const selectedById = new Map(selectedNodes.map((node) => [node.nodeId, node]));
  const orderedNodeIds = [
    ...parsed.orderedNodes.filter((nodeId) => selectedById.has(nodeId)),
    ...selectedNodes.map((node) => node.nodeId).filter((nodeId) => !parsed.orderedNodes.includes(nodeId)),
  ];
  const orderedSet = new Set(orderedNodeIds);

  const switchCasesByNodeId = new Map<string, string[]>();
  for (const edge of parsed.edges) {
    const sourceNode = selectedById.get(edge.source);
    if (!sourceNode) continue;
    const sourceDef = registry.get(sourceNode.type);
    if (sourceDef?.isBranching !== true || sourceNode.type !== 'switch') continue;
    if (['main', 'default', 'true', 'false'].includes(edge.type)) continue;

    const existing = switchCasesByNodeId.get(edge.source) || [];
    if (!existing.includes(edge.type)) {
      switchCasesByNodeId.set(edge.source, [...existing, edge.type]);
    }
  }

  const nodes: WorkflowNode[] = orderedNodeIds
    .map((nodeId) => selectedById.get(nodeId))
    .filter((node): node is SelectedNode => Boolean(node))
    .map((node) => {
      const def = registry.get(node.type);
      const cases = switchCasesByNodeId.get(node.nodeId);
      const config = cases && cases.length > 0
        ? { cases: cases.map((value) => ({ value, label: value })) }
        : {};

      return {
        id: node.nodeId,
        type: node.type,
        data: {
          label: def?.label || node.type,
          type: node.type,
          category: def?.category || node.role || 'action',
          config,
        },
      };
    });

  const proposedEdges = parsed.edges.filter((edge) =>
    orderedSet.has(edge.source) && orderedSet.has(edge.target)
  );
  const edges: WorkflowEdge[] = proposedEdges.map((edge, index) => ({
    id: `edge_seed_${index + 1}`,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    sourceHandle: edge.type !== 'main' ? edge.type : undefined,
    targetHandle: 'input',
  }));

  return {
    workflow: { nodes, edges },
    orderedNodeIds,
    proposedEdges,
  };
}
