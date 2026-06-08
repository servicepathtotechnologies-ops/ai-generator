import { callGemini } from '../lib/gemini';
import { logger } from '../lib/logger';

export type PropertyPopulationJsonPurpose = 'property_population' | 'field_directive_generation';

export interface PropertyPopulationJsonRequest {
  purpose: PropertyPopulationJsonPurpose;
  systemPrompt: string;
  message: string;
  allowedKeys?: string[];
  correlationId?: string;
  nodeId?: string;
  nodeType?: string;
}

export interface PropertyPopulationJsonSuccess {
  ok: true;
  values: Record<string, unknown>;
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
}

export interface PropertyPopulationJsonError {
  ok: false;
  code: 'INVALID_LLM_RESPONSE';
  rawResponse?: string;
  durationMs: number;
}

export type PropertyPopulationJsonOutput =
  | PropertyPopulationJsonSuccess
  | PropertyPopulationJsonError;

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;

export async function runPropertyPopulationJsonStage(
  input: PropertyPopulationJsonRequest,
): Promise<PropertyPopulationJsonOutput> {
  const startedAt = Date.now();
  const { purpose, systemPrompt, message, allowedKeys, correlationId, nodeId, nodeType } = input;

  logger.info({
    event: 'ai_pipeline_stage_start',
    stage: purpose,
    correlationId,
    nodeId,
    nodeType,
    inputSummary: `allowedKeys=${allowedKeys?.length ?? 0}`,
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
      stage: purpose,
      correlationId,
      nodeId,
      nodeType,
      error: 'LLM_CALL_FAILED',
      message: rawResponse,
    });
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
  }

  let parsed = parseJsonObject(text, allowedKeys);

  if (!parsed) {
    logger.warn({
      event: 'ai_pipeline_stage_retry',
      stage: purpose,
      correlationId,
      nodeId,
      nodeType,
      reason: 'JSON parse failed on first attempt',
    });

    try {
      const retryMessage =
        `${message}\n\nCRITICAL: Your previous response was not valid JSON. ` +
        'Return ONLY the JSON object, nothing else. No markdown fences.';
      const result = await callGemini(systemPrompt, retryMessage, MODEL, TEMPERATURE);
      text = result.text;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      parsed = parseJsonObject(text, allowedKeys);
    } catch (error) {
      const rawResponse = error instanceof Error ? error.message : String(error);
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: purpose,
        correlationId,
        nodeId,
        nodeType,
        error: 'LLM_RETRY_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
    }

    if (!parsed) {
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: purpose,
        correlationId,
        nodeId,
        nodeType,
        error: 'INVALID_LLM_RESPONSE',
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: text, durationMs: Date.now() - startedAt };
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info({
    event: 'ai_pipeline_stage_end',
    stage: purpose,
    correlationId,
    nodeId,
    nodeType,
    outputSummary: `keys=${Object.keys(parsed).length}`,
    durationMs,
  });

  return {
    ok: true,
    values: parsed,
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

function parseJsonObject(text: string, allowedKeys?: string[]): Record<string, unknown> | null {
  try {
    const cleaned = stripMarkdownFences(text);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(cleaned.substring(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const obj = parsed as Record<string, unknown>;
    if (!allowedKeys || allowedKeys.length === 0) return obj;

    const allowed = new Set(allowedKeys);
    return Object.fromEntries(
      Object.entries(obj).filter(([key]) => allowed.has(key)),
    );
  } catch {
    return null;
  }
}
