import { callGemini } from '../lib/gemini';
import { logger } from '../lib/logger';
import type { StructuredIntent } from './intent';

export interface StructuralPromptResult {
  ok: true;
  structuralPrompt: string;
  durationMs: number;
  llmCall: { model: string; temperature: number; promptTokens: number; completionTokens: number };
}

export interface StructuralPromptError {
  ok: false;
  code: 'INVALID_LLM_RESPONSE';
  rawResponse: string;
  durationMs: number;
}

export type StructuralPromptOutput = StructuralPromptResult | StructuralPromptError;

export interface StructuralPromptConstraints {
  selectedNodeConstraintsByStep?: Record<string, string[]>;
  selectedNodeConstraintsFlat?: string[];
}

const MODEL = 'gemini-3.5-flash';
const TEMPERATURE = 0.2;

function extractText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.content === 'string') return r.content;
  }
  return '';
}

function buildStructuralPromptInputs(intent: StructuredIntent, constraints?: StructuralPromptConstraints) {
  const selectedNodes = (constraints?.selectedNodeConstraintsFlat || []).join(', ') || 'nodes from intent';

  const systemPrompt = `You are a workflow blueprint architect. Your job is to generate a precise, structured, technical-theoretical explanation of a workflow based on the user's intent and selected nodes.

This blueprint serves TWO purposes:
1. Show the user a clear human-readable explanation of exactly what will be built
2. Guide the backend AI to correctly wire edges, branches, and operations

## OUTPUT FORMAT (MANDATORY)

Return ONLY plain text in this exact structure - no JSON, no markdown headers, no code blocks:

WORKFLOW: [One sentence describing the overall automation goal]

TRIGGER: [Trigger node name] - [What event starts this workflow and what data it collects]

FLOW:
[Step number]. [Node display name] - [Specific operation it performs, e.g. "sends a confirmation email to {{recipient}}"]
[For branching nodes, describe each case on its own line:]
  -> Case "[case value]": [Node display name] - [What operation runs in this case]
  -> Case "[case value]": [Node display name] - [What operation runs in this case]
  -> Case "[case value]": [Node display name] - [What operation runs in this case]

CONNECTIONS: [Describe the exact data flow - what data passes from each node to the next, and which field drives branching decisions]

## CRITICAL RULES

1. NEVER repeat the user's original prompt text - generate a NEW technical explanation
2. For Switch/If-Else nodes: ALWAYS list every branch case with its specific downstream action
3. Use the node's display name (e.g. "Gmail", "Slack", "Switch") not internal type names
4. Describe the SPECIFIC OPERATION each node performs (send email, post message, evaluate condition)
5. For branching: state EXACTLY which field value routes to which branch (e.g. "when status = success -> Gmail sends confirmation")
6. The CONNECTIONS section must describe the data field that drives routing decisions
7. Be specific about what data flows between nodes - not generic "data is passed"
8. Include explicit branch path mapping for every branch node (if_else/switch) and list each case outcome
9. Ensure each step states node responsibility and expected output effect so backend can compile summaryV2 fields

## EXAMPLE OUTPUT (for a payment status workflow):

WORKFLOW: Route payment notifications based on transaction status using a form submission trigger.

TRIGGER: Form Trigger - collects payment_status and order_id fields from form submission.

FLOW:
1. Switch - evaluates the payment_status field from the form submission
  -> Case "success": Gmail - sends a payment confirmation email to the customer
  -> Case "pending": Slack - posts a pending payment reminder to the #payments channel
  -> Case "failed": Slack - posts a payment failure alert to the #alerts channel

CONNECTIONS: Form Trigger outputs payment_status and order_id -> Switch reads payment_status to route -> each branch receives the full form payload for use in message content.

If USER_SELECTED_NODE_CONSTRAINTS are provided, the blueprint MUST only use those node types.`;

  const dataFlows = intent.dataFlows
    .map((flow) => `${flow.from} -> ${flow.to}: ${flow.dataDescription}`)
    .join('\n') || 'none specified';

  const message = `USER_INTENT:
${intent.intent}

TRIGGER_TYPE: ${intent.triggerType}

ACTIONS:
${intent.actions.map((action, index) => `${index + 1}. ${action}`).join('\n')}

DATA_FLOWS:
${dataFlows}

SELECTED_NODES: ${selectedNodes}

USER_SELECTED_NODE_CONSTRAINTS:
${JSON.stringify({
    selectedNodeConstraintsByStep: constraints?.selectedNodeConstraintsByStep || {},
    selectedNodeConstraintsFlat: constraints?.selectedNodeConstraintsFlat || [],
  }, null, 2)}`;

  return { systemPrompt, message };
}

export async function runStructuralPromptStage(
  intent: StructuredIntent,
  _catalog: string,
  correlationId?: string,
  constraints?: StructuralPromptConstraints,
): Promise<StructuralPromptOutput> {
  const startedAt = Date.now();
  logger.info({
    event: 'ai_pipeline_stage_start',
    stage: 'structural_prompt',
    correlationId,
    inputSummary: `actions=${intent.actions.length}`,
  });

  const { systemPrompt, message } = buildStructuralPromptInputs(intent, constraints);
  logger.info({
    event: 'ai_pipeline_llm_call',
    stage: 'structural_prompt',
    correlationId,
    model: MODEL,
    temperature: TEMPERATURE,
  });

  let text = '';
  let promptTokens = Math.ceil((systemPrompt.length + message.length) / 4);
  let completionTokens = 0;
  try {
    const result = await callGemini(systemPrompt, message, MODEL, TEMPERATURE);
    text = extractText(result.text);
    promptTokens = result.promptTokens;
    completionTokens = result.completionTokens;
  } catch (error) {
    const rawResponse = error instanceof Error ? error.message : String(error);
    logger.error({
      event: 'ai_pipeline_stage_error',
      stage: 'structural_prompt',
      correlationId,
      error: 'LLM_CALL_FAILED',
      message: rawResponse,
    });
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
  }

  if (!text || text.trim().length === 0) {
    logger.warn({ event: 'ai_pipeline_stage_retry', stage: 'structural_prompt', correlationId });
    try {
      const retryPrompt = [
        systemPrompt,
        '',
        'CRITICAL: You MUST return the workflow blueprint in the exact format specified. Start with "WORKFLOW:" and include TRIGGER:, FLOW:, and CONNECTIONS: sections. Describe every branch case explicitly.',
      ].join('\n');
      const result = await callGemini(retryPrompt, message, MODEL, TEMPERATURE);
      text = extractText(result.text);
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
    } catch (error) {
      const rawResponse = error instanceof Error ? error.message : String(error);
      logger.error({
        event: 'ai_pipeline_stage_error',
        stage: 'structural_prompt',
        correlationId,
        error: 'LLM_RETRY_FAILED',
        message: rawResponse,
      });
      return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse, durationMs: Date.now() - startedAt };
    }
  }

  if (!text || text.trim().length === 0) {
    logger.error({
      event: 'ai_pipeline_stage_error',
      stage: 'structural_prompt',
      correlationId,
      error: 'INVALID_LLM_RESPONSE',
    });
    return { ok: false, code: 'INVALID_LLM_RESPONSE', rawResponse: text ?? '', durationMs: Date.now() - startedAt };
  }

  const structuralPrompt = text.trim();
  const durationMs = Date.now() - startedAt;
  logger.info({
    event: 'ai_pipeline_stage_end',
    stage: 'structural_prompt',
    correlationId,
    outputSummary: `len=${structuralPrompt.length}`,
    durationMs,
  });

  return {
    ok: true,
    structuralPrompt,
    durationMs,
    llmCall: {
      model: MODEL,
      temperature: TEMPERATURE,
      promptTokens,
      completionTokens: completionTokens || Math.ceil(structuralPrompt.length / 4),
    },
  };
}
