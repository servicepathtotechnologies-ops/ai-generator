import { callGemini } from '../lib/gemini';
import { buildIntentPrompt } from '../lib/system-prompt-builder';
import { logger } from '../lib/logger';

// ─── Types (mirror worker's intent-stage.ts exactly so the response is compatible) ─

export interface StructuredIntent {
  intent: string;
  triggerType: 'schedule' | 'webhook' | 'form' | 'chat_trigger' | 'manual_trigger';
  actions: string[];
  dataFlows: Array<{ from: string; to: string; dataDescription: string }>;
  constraints: string[];
  originalPrompt: string;
}

export interface IntentStageResult {
  ok: true;
  intent: StructuredIntent;
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
  fallback?: boolean;
}

export interface IntentStageError {
  ok: false;
  code: 'INVALID_LLM_RESPONSE';
  rawResponse: string;
  durationMs: number;
}

export type IntentStageOutput = IntentStageResult | IntentStageError;

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.1;

// ─── Intent Stage ─────────────────────────────────────────────────────────────

export async function runIntentStage(
  userPrompt: string,
  catalog: string,
  correlationId?: string,
): Promise<IntentStageOutput> {
  const startedAt = Date.now();
  logger.info({ event: 'ai_pipeline_stage_start', stage: 'intent', correlationId });

  const { systemPrompt } = buildIntentPrompt(catalog, userPrompt);

  // First attempt
  let text: string;
  let promptTokens: number;
  let completionTokens: number;
  try {
    const result = await callGemini(systemPrompt, userPrompt, MODEL, TEMPERATURE);
    text = result.text;
    promptTokens = result.promptTokens;
    completionTokens = result.completionTokens;
  } catch (err) {
    logger.error({ event: 'ai_pipeline_stage_error', stage: 'intent', correlationId, error: String(err) });
    return buildFallback(userPrompt, systemPrompt, String(err), startedAt);
  }

  const parsed = tryParseIntent(text);
  if (parsed) {
    const durationMs = Date.now() - startedAt;
    logger.info({ event: 'ai_pipeline_stage_end', stage: 'intent', correlationId, durationMs });
    return { ok: true, intent: { ...parsed, originalPrompt: userPrompt }, durationMs, llmCall: { model: MODEL, temperature: TEMPERATURE, promptTokens, completionTokens } };
  }

  // Retry once with schema reminder
  logger.warn({ event: 'ai_pipeline_stage_retry', stage: 'intent', correlationId });
  try {
    const retryPrompt = systemPrompt + '\n\nCRITICAL: Your previous response was not valid JSON. Return ONLY the JSON object, nothing else.';
    const result2 = await callGemini(retryPrompt, userPrompt, MODEL, TEMPERATURE);
    const parsed2 = tryParseIntent(result2.text);
    if (parsed2) {
      const durationMs = Date.now() - startedAt;
      return { ok: true, intent: { ...parsed2, originalPrompt: userPrompt }, durationMs, llmCall: { model: MODEL, temperature: TEMPERATURE, promptTokens: result2.promptTokens, completionTokens: result2.completionTokens } };
    }
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: result2.text, durationMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: String(err), durationMs: Date.now() - startedAt };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildFallback(userPrompt: string, systemPrompt: string, rawResponse: string, startedAt: number): IntentStageResult {
  const intent = buildDeterministicIntent(userPrompt);
  return {
    ok: true,
    intent,
    durationMs: Date.now() - startedAt,
    fallback: true,
    llmCall: {
      model: MODEL,
      temperature: TEMPERATURE,
      promptTokens: Math.ceil(systemPrompt.length / 4),
      completionTokens: Math.ceil(rawResponse.length / 4),
    },
  };
}

function stripMarkdownFences(text: string): string {
  let cleaned = String(text || '').trim().replace(/^﻿/, '').trim();
  for (let i = 0; i < 5; i++) {
    const next = cleaned.replace(/^\s*```[a-z0-9_-]*\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned.replace(/^\s*```[a-z0-9_-]*\s*$/gim, '').trim();
}

function tryParseIntent(text: string): StructuredIntent | null {
  try {
    const cleaned = stripMarkdownFences(text);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return tryParsePartialIntent(cleaned.substring(start === -1 ? 0 : start));
    const obj = JSON.parse(cleaned.substring(start, end + 1));
    if (!obj.intent || !obj.triggerType || !Array.isArray(obj.actions)) return null;
    return {
      intent: String(obj.intent),
      triggerType: obj.triggerType,
      actions: obj.actions.map(String),
      dataFlows: Array.isArray(obj.dataFlows) ? obj.dataFlows : [],
      constraints: Array.isArray(obj.constraints) ? obj.constraints.map(String) : [],
      originalPrompt: '',
    };
  } catch {
    return null;
  }
}

function tryParsePartialIntent(partial: string): StructuredIntent | null {
  try {
    const intentMatch = partial.match(/"intent"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const triggerMatch = partial.match(/"triggerType"\s*:\s*"([^"]+)"/);
    const actionsMatch = partial.match(/"actions"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
    if (!intentMatch || !triggerMatch || !actionsMatch) return null;
    const actions = [...actionsMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    if (actions.length === 0) return null;
    const triggerType = triggerMatch[1] as StructuredIntent['triggerType'];
    const validTriggers: StructuredIntent['triggerType'][] = ['schedule', 'webhook', 'form', 'chat_trigger', 'manual_trigger'];
    if (!validTriggers.includes(triggerType)) return null;
    return { intent: intentMatch[1], triggerType, actions, dataFlows: [], constraints: [], originalPrompt: '' };
  } catch {
    return null;
  }
}

function buildDeterministicIntent(userPrompt: string): StructuredIntent {
  const prompt = userPrompt.trim();
  const text = prompt.toLowerCase();
  let triggerType: StructuredIntent['triggerType'] = 'manual_trigger';
  if (/\b(webhook|api call|http request)\b/.test(text)) triggerType = 'webhook';
  else if (/\b(form|submission|submitted)\b/.test(text)) triggerType = 'form';
  else if (/\b(chat|message from user|conversation)\b/.test(text)) triggerType = 'chat_trigger';
  else if (/\b(schedule|every|daily|weekly|cron)\b/.test(text)) triggerType = 'schedule';
  const actions = prompt.split(/[,;]|\b(?:and then|then)\b/i).map(s => s.trim()).filter(Boolean).slice(0, 12);
  return { intent: prompt, triggerType, actions: actions.length ? actions : [prompt], dataFlows: [], constraints: [], originalPrompt: prompt };
}
