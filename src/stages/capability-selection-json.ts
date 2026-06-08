import { callGemini } from '../lib/gemini';
import { logger } from '../lib/logger';

export type CapabilityIntentClass =
  | 'trigger'
  | 'data_source'
  | 'communication'
  | 'logic'
  | 'transformation'
  | 'generic_action';

export interface CapabilitySelectionPolicy {
  multiSelectAllowed: boolean;
  required: boolean;
}

export interface CapabilityOptionStep {
  stepId: string;
  stepText: string;
  intentClass: CapabilityIntentClass;
  candidateNodeTypes: string[];
  defaultSuggestedNodeType: string | null;
  selectionPolicy: CapabilitySelectionPolicy;
  confidence?: number;
  ambiguous?: boolean;
  reason?: string;
}

export interface CapabilitySelectionJsonRequest {
  systemPrompt: string;
  message: string;
  correlationId?: string;
}

export interface CapabilitySelectionJsonSuccess {
  ok: true;
  steps: CapabilityOptionStep[];
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
}

export interface CapabilitySelectionJsonError {
  ok: false;
  code: 'INVALID_LLM_RESPONSE';
  rawResponse?: string;
  durationMs: number;
}

export type CapabilitySelectionJsonOutput =
  | CapabilitySelectionJsonSuccess
  | CapabilitySelectionJsonError;

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;

export async function runCapabilitySelectionJsonStage(
  input: CapabilitySelectionJsonRequest,
): Promise<CapabilitySelectionJsonOutput> {
  const startedAt = Date.now();
  const { systemPrompt, message, correlationId } = input;

  logger.info({
    event: 'ai_pipeline_stage_start',
    stage: 'capability_selection_json',
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
      stage: 'capability_selection_json',
      correlationId,
      error: 'LLM_CALL_FAILED',
      message: rawResponse,
    });
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
  }

  let parsed = parseCapabilitySelection(text);

  if (!parsed) {
    logger.warn({
      event: 'ai_pipeline_stage_retry',
      stage: 'capability_selection_json',
      correlationId,
      reason: 'STRUCTURED_DECODE_FAILED',
    });

    try {
      const retryPrompt = `${systemPrompt}\n\nCRITICAL: Return ONLY valid JSON that conforms to the schema.`;
      const result = await callGemini(retryPrompt, message, MODEL, TEMPERATURE);
      text = result.text;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      parsed = parseCapabilitySelection(text);
    } catch (error) {
      const rawResponse = error instanceof Error ? error.message : String(error);
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'capability_selection_json',
        correlationId,
        error: 'LLM_RETRY_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
    }

    if (!parsed) {
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'capability_selection_json',
        correlationId,
        error: 'INVALID_LLM_RESPONSE',
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: text, durationMs: Date.now() - startedAt };
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info({
    event: 'ai_pipeline_stage_end',
    stage: 'capability_selection_json',
    correlationId,
    outputSummary: `steps=${parsed.length}`,
    durationMs,
  });

  return {
    ok: true,
    steps: parsed,
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
  return cleaned.replace(/^\s*```[a-z0-9_-]*\s*$/gim, '').trim();
}

function parseCapabilitySelection(input: unknown): CapabilityOptionStep[] | null {
  if (input && typeof input === 'object') {
    return validateCapabilitySelectionObject(input);
  }
  if (typeof input !== 'string') return null;
  const cleaned = stripMarkdownFences(input);
  try {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return tryParsePartialCapabilitySelection(cleaned);
    const full = validateCapabilitySelectionObject(JSON.parse(cleaned.substring(start, end + 1)));
    return full ?? tryParsePartialCapabilitySelection(cleaned);
  } catch {
    return tryParsePartialCapabilitySelection(cleaned);
  }
}

function tryParsePartialCapabilitySelection(text: string): CapabilityOptionStep[] | null {
  try {
    const stepsKeyMatch = /"steps"\s*:\s*\[/.exec(text);
    if (!stepsKeyMatch) return null;

    const arrayStart = text.indexOf('[', stepsKeyMatch.index);
    if (arrayStart === -1) return null;

    const steps: CapabilityOptionStep[] = [];
    let i = arrayStart + 1;

    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i += 1;
      if (i >= text.length || text[i] === ']') break;
      if (text[i] !== '{') break;

      let depth = 0;
      let inString = false;
      let escape = false;
      let j = i;

      for (; j < text.length; j += 1) {
        const ch = text[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\' && inString) {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              j += 1;
              break;
            }
          }
        }
      }

      if (depth !== 0) break;

      try {
        const obj = JSON.parse(text.substring(i, j));
        const validated = validateCapabilitySelectionObject({ steps: [obj] });
        if (validated && validated.length > 0) steps.push(validated[0]);
      } catch {
        break;
      }

      i = j;
    }

    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

function validateCapabilitySelectionObject(obj: unknown): CapabilityOptionStep[] | null {
  if (!obj || typeof obj !== 'object' || !Array.isArray((obj as Record<string, unknown>).steps)) {
    return null;
  }

  const validClasses: CapabilityIntentClass[] = [
    'trigger',
    'data_source',
    'communication',
    'logic',
    'transformation',
    'generic_action',
  ];
  const steps: CapabilityOptionStep[] = [];

  for (const raw of (obj as { steps: unknown[] }).steps) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, any>;
    const stepId = String(item.stepId || '').trim();
    const stepText = String(item.stepText || '').trim();
    const intentClass = String(item.intentClass || '').trim() as CapabilityIntentClass;
    const candidateNodeTypes = Array.isArray(item.candidateNodeTypes)
      ? item.candidateNodeTypes.map((value: unknown) => String(value || '').trim()).filter(Boolean)
      : [];

    if (!stepId || !stepText || !validClasses.includes(intentClass) || candidateNodeTypes.length === 0) {
      continue;
    }

    const defaultSuggestedNodeType =
      item.defaultSuggestedNodeType === null || item.defaultSuggestedNodeType === undefined
        ? null
        : String(item.defaultSuggestedNodeType || '').trim() || null;
    const confidenceRaw = Number(item.confidence);

    steps.push({
      stepId,
      stepText,
      intentClass,
      candidateNodeTypes,
      defaultSuggestedNodeType,
      selectionPolicy: {
        multiSelectAllowed: item.selectionPolicy?.multiSelectAllowed !== false,
        required: item.selectionPolicy?.required !== false,
      },
      confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : undefined,
      ambiguous: item.ambiguous === true,
      reason: typeof item.reason === 'string' ? item.reason : undefined,
    });
  }

  return steps.length > 0 ? steps : null;
}
