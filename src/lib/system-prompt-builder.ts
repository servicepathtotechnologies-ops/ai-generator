// Subset of the worker's system-prompt-builder.
// Extend here as more stages migrate to this service.

const INTENT_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['intent', 'triggerType', 'actions', 'dataFlows'],
  properties: {
    intent: { type: 'string' },
    triggerType: { type: 'string', enum: ['schedule', 'webhook', 'form', 'chat_trigger', 'manual_trigger'] },
    actions: { type: 'array', items: { type: 'string' } },
    dataFlows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          dataDescription: { type: 'string' },
        },
      },
    },
    constraints: { type: 'array', items: { type: 'string' } },
  },
};

export const CAPABILITY_SELECTION_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'stepId',
          'stepText',
          'intentClass',
          'candidateNodeTypes',
          'defaultSuggestedNodeType',
          'selectionPolicy',
        ],
        properties: {
          stepId: { type: 'string' },
          stepText: { type: 'string' },
          intentClass: {
            type: 'string',
            enum: ['trigger', 'data_source', 'communication', 'logic', 'transformation', 'generic_action'],
          },
          candidateNodeTypes: { type: 'array', items: { type: 'string' } },
          defaultSuggestedNodeType: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          ambiguous: { type: 'boolean' },
          reason: { type: 'string' },
          selectionPolicy: {
            type: 'object',
            required: ['multiSelectAllowed', 'required'],
            properties: {
              multiSelectAllowed: { type: 'boolean' },
              required: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
};

export interface SelectedNode {
  type: string;
  role: 'trigger' | 'action' | 'logic' | 'terminal';
  reason: string;
  nodeId: string;
}

export interface NodeSelectionPromptContext {
  selectedNodeConstraintsByStep?: Record<string, string[]>;
  selectedNodeConstraintsFlat?: string[];
}

export const NODE_SELECTION_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['selectedNodes'],
  properties: {
    selectedNodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'role', 'reason'],
        properties: {
          type: { type: 'string' },
          role: { type: 'string', enum: ['trigger', 'action', 'logic', 'terminal'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

export interface IntentPromptResult {
  systemPrompt: string;
  outputSchema: object;
}

/**
 * Builds the LLM system prompt for the intent extraction stage.
 * Mirrors worker's SystemPromptBuilder.buildIntentPrompt() exactly.
 */
export function buildIntentPrompt(nodeCatalog: string, userIntent: string): IntentPromptResult {
  const systemPrompt = [
    '## ROLE AND OBJECTIVE',
    'You are an intent extraction engine for a workflow automation platform.',
    'Your job is to read a natural language user request and extract a structured intent object.',
    'Do not generate a workflow. Only extract intent.',
    '',
    '## NODE CATALOG',
    'The following nodes are available on this platform (for context only — do not select nodes yet):',
    nodeCatalog,
    '',
    '## OUTPUT FORMAT',
    'You MUST return ONLY valid JSON conforming exactly to this schema:',
    JSON.stringify(INTENT_OUTPUT_SCHEMA, null, 2),
    '',
    '## HARD CONSTRAINTS',
    '- triggerType must be one of: schedule, webhook, form, chat_trigger, manual_trigger',
    '- actions must list every distinct action the user wants performed',
    '- dataFlows must describe every data movement between services',
    '- Return ONLY the JSON object. No explanation, no markdown, no extra text.',
    '- DO NOT include utility/transformation operations (set_variable, javascript, text_formatter,',
    '  json_parser, filter, sort, aggregate) in actions unless the user EXPLICITLY asked for them.',
    '  Data passing between nodes is automatic — no transformation node is needed for that.',
    '- PRESERVE SERVICE NAMES in every action string. If the user said "send via Gmail", write',
    '  "send via Gmail" — NOT "send email". If the user said "notify via Slack", write',
    '  "notify via Slack" — NOT "send notification". Never generalise a named service to a',
    '  generic description; the downstream node-selector relies on these exact names.',
    '',
    '## CRITICAL RULE — BRANCH NODE UNIQUENESS',
    'When multiple branches of a switch or if-else each require the same node type, you MUST emit',
    'one distinct step per branch with a unique step ID. NEVER collapse two branch actions into a',
    'single shared step. Each branch must have its own independent node instance.',
    'Example: a switch with 3 cases all using the same registry node type must produce 3 separate',
    'steps for that node type, NOT one shared step.',
    '',
    '## USER REQUEST',
    userIntent,
  ].join('\n');

  return { systemPrompt, outputSchema: INTENT_OUTPUT_SCHEMA };
}

/**
 * Builds the LLM system prompt for the capability-selection stage.
 * Mirrors worker's SystemPromptBuilder.buildCapabilitySelectionPrompt().
 */
export function buildCapabilitySelectionPrompt(nodeCatalog: string, userIntent: string): IntentPromptResult {
  const systemPrompt = [
    '## ROLE AND OBJECTIVE',
    'You are a capability-node suggestion engine for a workflow automation platform.',
    'Given user intent, output step-wise capability options using ONLY nodes from the catalog.',
    'Do not invent node types and do not output explanatory prose.',
    '',
    '## NODE CATALOG',
    nodeCatalog,
    '',
    '## OUTPUT FORMAT',
    'You MUST return ONLY valid JSON conforming exactly to this schema:',
    JSON.stringify(CAPABILITY_SELECTION_OUTPUT_SCHEMA, null, 2),
    '',
    '## HARD CONSTRAINTS',
    '- Each step must represent one intent action.',
    '- Include one trigger step and one step for every action in the structured intent.',
    '- candidateNodeTypes must include only node types present in NODE CATALOG.',
    '- defaultSuggestedNodeType must be one of candidateNodeTypes or null if none.',
    '- Use null defaultSuggestedNodeType and ambiguous=true when the prompt does not identify one exact registry node.',
    '- Use exactly one candidateNodeType only when confidence is high.',
    '- confidence must be between 0 and 1.',
    '- selectionPolicy.multiSelectAllowed must be true.',
    '- Return ONLY the JSON object. No markdown, no extra text.',
    '',
    '## CRITICAL RULE - PRESERVE SERVICE NAMES VERBATIM',
    'When the user explicitly names a service (e.g., "send via Gmail", "notify via Slack", "post to Twitter"),',
    'you MUST select that exact service\'s node type from the catalog.',
    'Examples:',
    '- "Gmail" -> google_gmail',
    '- "Slack" -> slack_message or slack_webhook',
    '- "Twitter" -> twitter',
    '- "Sheets" -> google_sheets',
    '- "Drive" -> google_drive',
    'NEVER substitute a generic alternative (e.g., "email" -> amazon_ses) when the user named a specific service.',
    '',
    '## CRITICAL RULE - DETECT CONDITIONAL LOGIC AND BRANCHING',
    'When the user describes conditional logic (if/else, switch, branching), you MUST emit a logic step:',
    '- Keywords: "if", "else", "when", "otherwise", "based on", "depending on", "route by", "check condition"',
    '- Operators: >, <, <=, >=, ==, !=',
    '- Patterns: "if X then Y else Z", "when X do Y", "route based on X"',
    'For binary conditions (true/false), use if_else. For multi-case conditions (3+ options), use switch.',
    'The logic step should have intentClass: "logic" and candidateNodeTypes: ["if_else"] or ["switch"].',
    '',
    '## BRANCHING WORKFLOW AWARENESS',
    'When identifying branching workflows:',
    '- Recognize that branches create MULTIPLE EXECUTION PATHS from a single decision point',
    '- Each branch path may require DIFFERENT nodes and actions',
    '- Example: "if priority is high, send via Slack, else send via email"',
    '  -> This requires: if_else node + Slack node (true branch) + email node (false branch)',
    '- Example: "route based on status: pending->notify manager, approved->send invoice, rejected->log"',
    '  -> This requires: switch node + 3 different action nodes (one per case)',
    '- When a branch requires an action, emit a SEPARATE step for that branch\'s action',
    '- Linear workflows (no branching) should have ONE step per action',
    '- Branching workflows should have ONE step per BRANCH ACTION (multiple steps for same action type if different branches)',
    '',
    '## CRITICAL RULE - PREFER DOMAIN-SPECIFIC NODES',
    'When selecting nodes for communication-intent steps (send, notify, message, email):',
    '- Prioritize nodes in the "communication" category (Gmail, Slack, Telegram, Discord)',
    '- Deprioritize nodes in the "data" or "enterprise" category (Workday, Salesforce, SAP)',
    '- Generic keywords (data, api, integration) should NOT boost a node\'s score for communication steps',
    '- Always prefer the service explicitly named by the user over generic alternatives',
    '',
    '## USER INTENT',
    userIntent,
  ].join('\n');

  return { systemPrompt, outputSchema: CAPABILITY_SELECTION_OUTPUT_SCHEMA };
}

/**
 * Builds the LLM system prompt for the node-selection stage.
 * Mirrors the worker prompt contract: select a minimal registry-backed node set.
 */
export function buildNodeSelectionPrompt(
  nodeCatalog: string,
  userIntent: string,
  ctx?: NodeSelectionPromptContext,
): IntentPromptResult {
  const allowedByStepText = ctx?.selectedNodeConstraintsByStep
    ? JSON.stringify(ctx.selectedNodeConstraintsByStep, null, 2)
    : '(none)';
  const allowedFlatText = ctx?.selectedNodeConstraintsFlat?.length
    ? JSON.stringify(ctx.selectedNodeConstraintsFlat, null, 2)
    : '(none)';

  const systemPrompt = [
    '## ROLE AND OBJECTIVE',
    'You are a node selection engine for a workflow automation platform.',
    'Your job is to select the minimal set of node types needed to fulfill the user intent.',
    'You MUST select nodes ONLY from the NODE CATALOG below. Do not invent node types.',
    '',
    '## NODE CATALOG',
    nodeCatalog,
    '',
    '## USER-CONFIRMED NODE CONSTRAINTS',
    'The user may have explicitly selected node candidates in a prior capability step.',
    `Allowed by step: ${allowedByStepText}`,
    `Allowed flat list: ${allowedFlatText}`,
    'If constraints are provided, selectedNodes MUST only use those node types.',
    'If allowed flat list is not empty, every selected node type MUST belong to that list.',
    '',
    '## OUTPUT FORMAT',
    'You MUST return ONLY valid JSON conforming exactly to this schema:',
    JSON.stringify(NODE_SELECTION_OUTPUT_SCHEMA, null, 2),
    '',
    '## HARD CONSTRAINTS - TRIGGER AND MINIMAL SET',
    '- You MUST include exactly ONE trigger node where isTrigger is true in the catalog.',
    '- Select the MINIMAL necessary set of nodes. Do not add nodes not implied by the user intent.',
    '- Every selected node type MUST exist in the NODE CATALOG above.',
    '- Assign role "trigger" for the trigger, "logic" for conditional or routing nodes,',
    '  "terminal" for final output nodes, and "action" for all other work nodes.',
    '- Return ONLY the JSON object. No markdown, no explanation, no extra text.',
    '',
    '## CRITICAL RULE - ONLY WHAT THE USER ASKED FOR',
    'Select ONLY nodes that directly implement what the user described.',
    'Never add helper, logging, monitoring, retry, transform, parser, formatter, or utility nodes unless',
    'the user explicitly asked for that operation by name.',
    'Data flowing between nodes is automatic and does not require a transformation node.',
    '',
    '## CRITICAL RULE - PRESERVE EXPLICIT SERVICE NAMES',
    'When the user names a service such as Gmail, Slack, Sheets, Drive, Salesforce, or Zoom,',
    'select that service-specific node from the live catalog instead of a generic substitute.',
    '',
    '## CRITICAL RULE - BRANCH NODE UNIQUENESS',
    'When the workflow contains a switch or if-else node, every branch must have its own',
    'independent downstream node instance. If multiple branches need the same node type,',
    'emit multiple selectedNodes entries of that type, one per branch.',
    'Do not share one terminal/output node across exclusive branches.',
    '',
    '## CONTROL FLOW NODE SELECTION GUIDE',
    'Use if_else for binary conditions: if, when, approve/reject, pass/fail, yes/no, true/false,',
    'or comparisons such as >, <, <=, >=, ==, !=.',
    'Use switch for 3 or more cases from a single field: status, category, priority, state, route by,',
    'depending on, switch on, case, or multiple named outcomes.',
    'Use loop only when the user asks to iterate, for each item, repeat, batch process, or process all items.',
    '',
    '## USER INTENT',
    userIntent,
  ].join('\n');

  return { systemPrompt, outputSchema: NODE_SELECTION_OUTPUT_SCHEMA };
}
