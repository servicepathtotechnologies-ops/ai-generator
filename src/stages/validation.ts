import { callGemini } from '../lib/gemini';
import { logger } from '../lib/logger';
import {
  buildRepairPrompt,
  buildValidationPrompt,
  type ProposedEdge,
  type SelectedNode,
} from '../lib/system-prompt-builder';

export interface WorkflowNode {
  id: string;
  type: string;
  data?: {
    label?: string;
    type?: string;
    category?: string;
    config?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface WorkflowEdge {
  id?: string;
  source: string;
  target: string;
  type?: string;
  sourceHandle?: string;
  targetHandle?: string;
  [key: string]: unknown;
}

export interface Workflow {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  metadata?: unknown;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  description: string;
  suggestedFix?: string;
}

export interface ValidationLlmSuccess {
  ok: true;
  status: 'pass' | 'fail';
  issues: ValidationIssue[];
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
}

export interface ValidationLlmError {
  ok: false;
  code: 'INVALID_LLM_RESPONSE';
  rawResponse?: string;
  durationMs: number;
}

export type ValidationLlmOutput = ValidationLlmSuccess | ValidationLlmError;

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;

export async function runValidationLlmStage(
  workflow: Workflow,
  catalog: string,
  userIntent: string,
  selectedNodes?: SelectedNode[],
  proposedEdges?: ProposedEdge[],
  correlationId?: string,
  structuralPrompt?: string,
): Promise<ValidationLlmOutput> {
  const startedAt = Date.now();

  logger.info({
    event: 'ai_pipeline_stage_start',
    stage: 'validation',
    correlationId,
    inputSummary: `nodes=${workflow.nodes.length}, edges=${workflow.edges.length}`,
  });

  const { systemPrompt } = buildValidationPrompt(catalog, userIntent, {
    selectedNodes,
    edgeList: proposedEdges,
  });

  const message = buildValidationMessage(userIntent, workflow, structuralPrompt);

  logger.info({
    event: 'ai_pipeline_llm_call',
    stage: 'validation',
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
    logger.warn({
      event: 'ai_pipeline_stage_error',
      stage: 'validation',
      correlationId,
      error: 'LLM_CALL_FAILED',
      message: rawResponse,
    });
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
  }

  let parsed = tryParseValidationResult(text);

  if (!parsed) {
    logger.warn({
      event: 'ai_pipeline_stage_retry',
      stage: 'validation',
      correlationId,
      reason: 'JSON parse failed on first attempt',
    });

    try {
      const retryPrompt = `${systemPrompt}\n\nCRITICAL: Return ONLY valid JSON. No markdown fences, no explanation. Start with { and end with }.`;
      const result = await callGemini(retryPrompt, message, MODEL, TEMPERATURE);
      text = result.text;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      parsed = tryParseValidationResult(text);
    } catch (error) {
      const rawResponse = error instanceof Error ? error.message : String(error);
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'validation',
        correlationId,
        error: 'LLM_RETRY_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
    }

    if (!parsed) {
      logger.warn({
        event: 'ai_pipeline_validation_parse_failed',
        stage: 'validation',
        correlationId,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: text, durationMs: Date.now() - startedAt };
    }
  }

  const finalParsed = await maybeRepairAndRevalidate(
    parsed,
    workflow,
    catalog,
    userIntent,
    selectedNodes,
    proposedEdges,
    correlationId,
  );

  const durationMs = Date.now() - startedAt;
  logger.info({
    event: 'ai_pipeline_stage_end',
    stage: 'validation',
    correlationId,
    outputSummary: `status=${finalParsed.status}, issues=${finalParsed.issues.length}`,
    durationMs,
  });

  return {
    ok: true,
    status: finalParsed.status,
    issues: finalParsed.issues,
    durationMs,
    llmCall: {
      model: MODEL,
      temperature: TEMPERATURE,
      promptTokens,
      completionTokens: completionTokens || Math.ceil(text.length / 4),
    },
  };
}

function buildValidationMessage(userIntent: string, workflow: Workflow, structuralPrompt?: string): string {
  return `USER_INTENT:\n${userIntent}${structuralPrompt ? `\n\nWORKFLOW_BLUEPRINT:\n${structuralPrompt}` : ''}\n\nWORKFLOW_GRAPH:\n${JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }, null, 2)}`;
}

async function maybeRepairAndRevalidate(
  parsed: { status: 'pass' | 'fail'; issues: ValidationIssue[] },
  workflow: Workflow,
  catalog: string,
  userIntent: string,
  selectedNodes: SelectedNode[] | undefined,
  proposedEdges: ProposedEdge[] | undefined,
  correlationId: string | undefined,
): Promise<{ status: 'pass' | 'fail'; issues: ValidationIssue[] }> {
  const errorIssues = parsed.issues.filter((issue) => issue.severity === 'error');
  if (parsed.status !== 'fail' || errorIssues.length === 0) {
    return parsed;
  }

  logger.info({
    event: 'ai_pipeline_repair_pass',
    stage: 'validation',
    correlationId,
    errorCount: errorIssues.length,
  });

  const { systemPrompt: repairPrompt } = buildRepairPrompt(catalog, userIntent, {
    selectedNodes,
    edgeList: proposedEdges,
    validationIssues: errorIssues,
  });

  try {
    const repairResult = await callGemini(
      repairPrompt,
      `USER_INTENT:\n${userIntent}`,
      MODEL,
      TEMPERATURE,
    );
    const repairedGraph = tryParseRepairedGraph(repairResult.text);

    if (!repairedGraph) {
      logger.warn({
        event: 'ai_pipeline_repair_incomplete',
        stage: 'validation',
        correlationId,
        remainingErrors: errorIssues.length,
      });
      return parsed;
    }

    const { systemPrompt: revalidatePrompt } = buildValidationPrompt(catalog, userIntent, {
      selectedNodes,
      edgeList: repairedGraph.edges,
    });

    try {
      const revalidateResult = await callGemini(
        revalidatePrompt,
        `USER_INTENT:\n${userIntent}\n\nWORKFLOW_GRAPH:\n${JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }, null, 2)}`,
        MODEL,
        TEMPERATURE,
      );
      const revalidated = tryParseValidationResult(revalidateResult.text);
      const remainingErrors = revalidated?.issues.filter((issue) => issue.severity === 'error') ?? errorIssues;
      if (remainingErrors.length > 0) {
        logger.warn({
          event: 'ai_pipeline_repair_incomplete',
          stage: 'validation',
          correlationId,
          remainingErrors: remainingErrors.length,
        });
      }
      return revalidated ?? parsed;
    } catch (error) {
      logger.warn({
        event: 'ai_pipeline_revalidate_failed',
        stage: 'validation',
        correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
      return parsed;
    }
  } catch (error) {
    logger.warn({
      event: 'ai_pipeline_repair_failed',
      stage: 'validation',
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return parsed;
  }
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

function tryParseValidationResult(text: string): { status: 'pass' | 'fail'; issues: ValidationIssue[] } | null {
  try {
    const cleaned = stripMarkdownFences(text);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(cleaned.substring(start, end + 1)) as Record<string, unknown>;
    if (!obj.status || !Array.isArray(obj.issues)) return null;
    return {
      status: obj.status === 'pass' ? 'pass' : 'fail',
      issues: obj.issues.map((issue) => {
        const item = issue && typeof issue === 'object' ? issue as Record<string, unknown> : {};
        const suggestedFix = item.suggestedFix ? String(item.suggestedFix) : undefined;
        return {
          severity: item.severity === 'error' ? 'error' : 'warning',
          description: String(item.description || ''),
          suggestedFix,
        };
      }),
    };
  } catch {
    return null;
  }
}

function tryParseRepairedGraph(text: string): { nodes: unknown[]; edges: ProposedEdge[] } | null {
  try {
    const cleaned = stripMarkdownFences(text);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(cleaned.substring(start, end + 1)) as Record<string, unknown>;
    if (!Array.isArray(obj.orderedNodes) && !Array.isArray(obj.nodes)) return null;
    const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];
    return {
      nodes: Array.isArray(obj.nodes) ? obj.nodes : [],
      edges: rawEdges
        .map((edge) => normalizeProposedEdge(edge))
        .filter((edge): edge is ProposedEdge => edge !== null),
    };
  } catch {
    return null;
  }
}

function normalizeProposedEdge(value: unknown): ProposedEdge | null {
  if (!value || typeof value !== 'object') return null;
  const edge = value as Record<string, unknown>;
  const source = String(edge.source || '').trim();
  const target = String(edge.target || '').trim();
  const type = String(edge.type || '').trim();
  if (!source || !target || !type) return null;
  return { source, target, type };
}
