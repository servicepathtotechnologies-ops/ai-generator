import { callGemini } from '../lib/gemini';
import { logger } from '../lib/logger';

export interface ProposedEdge {
  source: string;
  target: string;
  type: string;
}

export interface EdgeReasoningJsonRequest {
  systemPrompt: string;
  message: string;
  correlationId?: string;
}

export interface EdgeReasoningJsonSuccess {
  ok: true;
  orderedNodes: string[];
  edges: ProposedEdge[];
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
}

export interface EdgeReasoningJsonError {
  ok: false;
  code: 'CYCLE_DETECTED' | 'INVALID_LLM_RESPONSE';
  rawResponse?: string;
  durationMs: number;
}

export type EdgeReasoningJsonOutput = EdgeReasoningJsonSuccess | EdgeReasoningJsonError;

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;

export async function runEdgeReasoningJsonStage(
  input: EdgeReasoningJsonRequest,
): Promise<EdgeReasoningJsonOutput> {
  const startedAt = Date.now();
  const { systemPrompt, message, correlationId } = input;

  logger.info({
    event: 'ai_pipeline_stage_start',
    stage: 'edge_reasoning_json',
    correlationId,
    inputSummary: `prompt_len=${systemPrompt.length},message_len=${message.length}`,
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
    logger.warn({
      event: 'ai_pipeline_stage_error',
      stage: 'edge_reasoning_json',
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
      stage: 'edge_reasoning_json',
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
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'edge_reasoning_json',
        correlationId,
        error: 'LLM_RETRY_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
    }

    if (!parsed) {
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'edge_reasoning_json',
        correlationId,
        error: 'INVALID_LLM_RESPONSE',
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: text, durationMs: Date.now() - startedAt };
    }
  }

  const cycleInfo = detectCycle(parsed.orderedNodes, parsed.edges);
  if (cycleInfo) {
    logger.warn({
      event: 'ai_pipeline_cycle_detected',
      stage: 'edge_reasoning_json',
      correlationId,
      cycleInfo,
    });

    const cycleReprompt = `${systemPrompt}\n\nCRITICAL: Your previous response contained a cycle: ${cycleInfo}. You MUST return a corrected graph with no cycles.`;

    try {
      const result = await callGemini(cycleReprompt, message, MODEL, TEMPERATURE);
      text = result.text;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
    } catch (error) {
      const rawResponse = error instanceof Error ? error.message : String(error);
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'edge_reasoning_json',
        correlationId,
        error: 'CYCLE_REPROMPT_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'CYCLE_DETECTED', rawResponse, durationMs: Date.now() - startedAt };
    }

    const reparsed = parseEdgeReasoning(text);
    if (!reparsed || detectCycle(reparsed.orderedNodes, reparsed.edges)) {
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'edge_reasoning_json',
        correlationId,
        error: 'CYCLE_DETECTED',
      });
      return { ok: false, code: 'CYCLE_DETECTED', rawResponse: text, durationMs: Date.now() - startedAt };
    }
    parsed = reparsed;
  }

  const durationMs = Date.now() - startedAt;
  logger.info({
    event: 'ai_pipeline_stage_end',
    stage: 'edge_reasoning_json',
    correlationId,
    outputSummary: `orderedNodes=${parsed.orderedNodes.length},edges=${parsed.edges.length}`,
    durationMs,
  });

  return {
    ok: true,
    orderedNodes: parsed.orderedNodes,
    edges: parsed.edges,
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
  let cleaned = String(text || '').trim().replace(/^﻿/, '').trim();
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
