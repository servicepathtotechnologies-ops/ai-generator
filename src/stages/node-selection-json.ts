import { callGemini } from '../lib/gemini';
import { logger } from '../lib/logger';

export type NodeSelectionRole = 'trigger' | 'action' | 'logic' | 'terminal';

export interface NodeSelectionJsonItem {
  type: string;
  role: NodeSelectionRole;
  reason: string;
}

export interface NodeSelectionJsonRequest {
  systemPrompt: string;
  message: string;
  correlationId?: string;
}

export interface NodeSelectionJsonSuccess {
  ok: true;
  selectedNodes: NodeSelectionJsonItem[];
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
}

export interface NodeSelectionJsonError {
  ok: false;
  code: 'INVALID_LLM_RESPONSE';
  rawResponse?: string;
  durationMs: number;
}

export type NodeSelectionJsonOutput =
  | NodeSelectionJsonSuccess
  | NodeSelectionJsonError;

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;

export async function runNodeSelectionJsonStage(
  input: NodeSelectionJsonRequest,
): Promise<NodeSelectionJsonOutput> {
  const startedAt = Date.now();
  const { systemPrompt, message, correlationId } = input;

  logger.info({
    event: 'ai_pipeline_stage_start',
    stage: 'node_selection_json',
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
      stage: 'node_selection_json',
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
      stage: 'node_selection_json',
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
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'node_selection_json',
        correlationId,
        error: 'LLM_RETRY_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
    }

    if (!parsed) {
      logger.warn({
        event: 'ai_pipeline_stage_error',
        stage: 'node_selection_json',
        correlationId,
        error: 'INVALID_LLM_RESPONSE',
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: text, durationMs: Date.now() - startedAt };
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info({
    event: 'ai_pipeline_stage_end',
    stage: 'node_selection_json',
    correlationId,
    outputSummary: `selectedNodes=${parsed.length}`,
    durationMs,
  });

  return {
    ok: true,
    selectedNodes: parsed,
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

function parseNodeSelection(input: unknown): NodeSelectionJsonItem[] | null {
  if (input && typeof input === 'object') {
    return validateNodeSelectionObject(input);
  }
  if (typeof input !== 'string') return null;

  const cleaned = stripMarkdownFences(input);
  try {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return tryParsePartialNodeSelection(cleaned);
    const full = validateNodeSelectionObject(JSON.parse(cleaned.substring(start, end + 1)));
    return full ?? tryParsePartialNodeSelection(cleaned);
  } catch {
    return tryParsePartialNodeSelection(cleaned);
  }
}

function tryParsePartialNodeSelection(text: string): NodeSelectionJsonItem[] | null {
  try {
    const keyMatch = /"selectedNodes"\s*:\s*\[/.exec(text);
    if (!keyMatch) return null;

    const arrayStart = text.indexOf('[', keyMatch.index);
    if (arrayStart === -1) return null;

    const selectedNodes: NodeSelectionJsonItem[] = [];
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
        const validated = validateNodeSelectionObject({ selectedNodes: [obj] });
        if (validated && validated.length > 0) selectedNodes.push(validated[0]);
      } catch {
        break;
      }

      i = j;
    }

    return selectedNodes.length > 0 ? selectedNodes : null;
  } catch {
    return null;
  }
}

function validateNodeSelectionObject(obj: unknown): NodeSelectionJsonItem[] | null {
  if (!obj || typeof obj !== 'object' || !Array.isArray((obj as Record<string, unknown>).selectedNodes)) {
    return null;
  }

  const validRoles: NodeSelectionRole[] = ['trigger', 'action', 'logic', 'terminal'];
  const selectedNodes: NodeSelectionJsonItem[] = [];

  for (const raw of (obj as { selectedNodes: unknown[] }).selectedNodes) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const type = String(item.type || '').trim();
    const role = String(item.role || '').trim() as NodeSelectionRole;
    const reason = String(item.reason || '').trim();
    if (!type || !validRoles.includes(role) || !reason) continue;
    selectedNodes.push({ type, role, reason });
  }

  return selectedNodes.length > 0 ? selectedNodes : null;
}
