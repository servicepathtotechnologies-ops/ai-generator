import { callGemini } from '../lib/gemini';
import { createCatalogRegistry, type CatalogRegistry } from '../lib/catalog-registry';
import { logger } from '../lib/logger';
import {
  buildNodeSelectionPrompt,
  type SelectedNode,
} from '../lib/system-prompt-builder';
import type { StructuredIntent } from './intent';

export interface NodeSelectionResult {
  ok: true;
  selectedNodes: SelectedNode[];
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
}

export interface NodeSelectionError {
  ok: false;
  code: 'NO_VALID_NODES' | 'INVALID_LLM_RESPONSE';
  rawResponse: string;
  durationMs: number;
}

export type NodeSelectionOutput = NodeSelectionResult | NodeSelectionError;

export interface NodeSelectionConstraints {
  selectedNodeConstraintsByStep?: Record<string, string[]>;
  selectedNodeConstraintsFlat?: string[];
  requiredNodeTypes?: string[];
}

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;

export async function runNodeSelectionStage(
  intent: StructuredIntent,
  catalog: string,
  correlationId?: string,
  structuralPrompt?: string,
  constraints?: NodeSelectionConstraints,
): Promise<NodeSelectionOutput> {
  const startedAt = Date.now();
  const registry = createCatalogRegistry(catalog);
  const inputSummary = `actions=${intent.actions.length}, triggerType=${intent.triggerType}`;

  logger.info({
    event: 'ai_pipeline_stage_start',
    stage: 'node_selection',
    correlationId,
    inputSummary,
  });

  const { systemPrompt } = buildNodeSelectionPrompt(catalog, intent.intent, {
    selectedNodeConstraintsByStep: constraints?.selectedNodeConstraintsByStep,
    selectedNodeConstraintsFlat: constraints?.selectedNodeConstraintsFlat,
  });

  const message = `STRUCTURED_INTENT:\n${JSON.stringify(intent, null, 2)}${structuralPrompt ? `\n\nWORKFLOW_BLUEPRINT:\n${structuralPrompt}` : ''}`;

  logger.info({
    event: 'ai_pipeline_llm_call',
    stage: 'node_selection',
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
      stage: 'node_selection',
      correlationId,
      error: 'LLM_CALL_FAILED',
      message: rawResponse,
    });
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
  }

  let parsed = parseNodeSelection(text);

  if (!parsed) {
    logger.warn({
      event: 'ai_pipeline_stage_retry',
      stage: 'node_selection',
      correlationId,
      reason: 'STRUCTURED_DECODE_FAILED',
    });

    try {
      const retryPrompt = `${systemPrompt}\n\nCRITICAL: Return ONLY valid JSON. No markdown, no explanation.`;
      const result = await callGemini(retryPrompt, message, MODEL, TEMPERATURE);
      text = result.text;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      parsed = parseNodeSelection(text);
    } catch (error) {
      const rawResponse = error instanceof Error ? error.message : String(error);
      logger.error({
        event: 'ai_pipeline_stage_error',
        stage: 'node_selection',
        correlationId,
        error: 'LLM_RETRY_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
    }

    if (!parsed) {
      logger.error({
        event: 'ai_pipeline_stage_error',
        stage: 'node_selection',
        correlationId,
        error: 'INVALID_LLM_RESPONSE',
        llmResponse: text,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: text, durationMs: Date.now() - startedAt };
    }
  }

  const validNodes = enforceCatalogSelectionContract(parsed, registry, correlationId, constraints);
  const durationMs = Date.now() - startedAt;

  if (validNodes.length === 0) {
    logger.error({
      event: 'ai_pipeline_stage_error',
      stage: 'node_selection',
      correlationId,
      error: 'NO_VALID_NODES',
      llmResponse: text,
    });
    return { ok: false, code: 'NO_VALID_NODES', rawResponse: text, durationMs };
  }

  logger.info({
    event: 'ai_pipeline_stage_end',
    stage: 'node_selection',
    correlationId,
    outputSummary: `selectedNodes=${validNodes.length}`,
    durationMs,
  });

  return {
    ok: true,
    selectedNodes: validNodes,
    durationMs,
    llmCall: {
      model: MODEL,
      temperature: TEMPERATURE,
      promptTokens,
      completionTokens: completionTokens || Math.ceil(text.length / 4),
    },
  };
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

function parseNodeSelection(input: unknown): Array<{ type: string; role: SelectedNode['role']; reason: string }> | null {
  if (input && typeof input === 'object') {
    return validateNodeSelectionObject(input);
  }
  if (typeof input !== 'string') return null;

  try {
    const cleaned = stripMarkdownFences(input);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(cleaned.substring(start, end + 1));
    return validateNodeSelectionObject(obj);
  } catch {
    return null;
  }
}

function validateNodeSelectionObject(
  obj: any,
): Array<{ type: string; role: SelectedNode['role']; reason: string }> | null {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.selectedNodes)) return null;

  const validRoles: Array<SelectedNode['role']> = ['trigger', 'action', 'logic', 'terminal'];
  const parsed: Array<{ type: string; role: SelectedNode['role']; reason: string }> = [];

  for (const raw of obj.selectedNodes) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type || '').trim();
    const role = String(raw.role || '').trim() as SelectedNode['role'];
    const reason = String(raw.reason || '').trim();
    if (!type || !validRoles.includes(role) || !reason) continue;
    parsed.push({ type, role, reason });
  }

  return parsed.length > 0 ? parsed : null;
}

export function enforceCatalogSelectionContract(
  parsed: Array<{ type: string; role: SelectedNode['role']; reason: string }>,
  registry: CatalogRegistry,
  correlationId?: string,
  constraints?: NodeSelectionConstraints,
): SelectedNode[] {
  const allowedSet = new Set(
    (constraints?.selectedNodeConstraintsFlat || [])
      .map((type) => registry.resolveAlias(type) || type)
      .filter(Boolean),
  );
  const requiredTypes = [
    ...new Set(
      (constraints?.requiredNodeTypes || [])
        .map((type) => registry.resolveAlias(type) || type)
        .filter(Boolean),
    ),
  ];

  const kept: SelectedNode[] = [];
  for (const node of parsed) {
    const canonical = registry.resolveAlias(node.type) || node.type;
    const def = registry.get(canonical);

    if (!def) {
      logger.warn({
        event: 'ai_pipeline_unknown_node_type',
        stage: 'node_selection',
        correlationId,
        unknownType: node.type,
      });
      continue;
    }

    if (allowedSet.size > 0 && !allowedSet.has(canonical)) {
      logger.warn({
        event: 'ai_pipeline_node_not_allowed_by_capability_selection',
        stage: 'node_selection',
        correlationId,
        nodeType: canonical,
      });
      continue;
    }

    const typeCount = kept.filter((selected) => selected.type === canonical).length + 1;
    kept.push({
      type: canonical,
      role: deriveNodeRole(canonical, registry),
      reason: node.reason,
      nodeId: `node_${canonical}_${typeCount}`,
    });
  }

  const withoutExtraTriggers: SelectedNode[] = [];
  let hasTrigger = false;
  for (const node of kept) {
    if (node.role === 'trigger') {
      if (hasTrigger) continue;
      hasTrigger = true;
    }
    withoutExtraTriggers.push(node);
  }

  if (!hasTrigger) {
    const fallbackTrigger = registry.resolveAlias('manual_trigger') || 'manual_trigger';
    if (registry.get(fallbackTrigger)) {
      withoutExtraTriggers.unshift({
        type: fallbackTrigger,
        role: 'trigger',
        reason: 'Required trigger selected from registry',
        nodeId: `node_${fallbackTrigger}_1`,
      });
    }
  }

  const seen = new Set(withoutExtraTriggers.map((node) => node.type));
  for (const reqType of requiredTypes) {
    const def = registry.get(reqType);
    if (!def) continue;

    const isBranching = def.isBranching === true;
    if (!isBranching && seen.has(reqType)) continue;

    const reqTypeCount = withoutExtraTriggers.filter((node) => node.type === reqType).length + 1;
    withoutExtraTriggers.push({
      type: reqType,
      role: deriveNodeRole(reqType, registry),
      reason: 'Required by user-confirmed capability selection',
      nodeId: `node_${reqType}_${reqTypeCount}`,
    });
    seen.add(reqType);
  }

  return withoutExtraTriggers;
}

function deriveNodeRole(nodeType: string, registry: CatalogRegistry): SelectedNode['role'] {
  if (registry.isTrigger(nodeType)) return 'trigger';

  const def = registry.get(nodeType);
  const category = String(def?.category || registry.getCategory(nodeType) || '').toLowerCase();
  if (category === 'logic') return 'logic';
  if (
    def?.workflowBehavior?.alwaysTerminal === true ||
    def?.isTerminal === true ||
    def?.maxOutDegree === 0 ||
    category === 'output'
  ) {
    return 'terminal';
  }

  return 'action';
}
