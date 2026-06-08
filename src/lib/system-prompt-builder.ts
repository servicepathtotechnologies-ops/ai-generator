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

export interface ProposedEdge {
  source: string;
  target: string;
  type: 'main' | 'true' | 'false' | string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  description: string;
  suggestedFix?: string;
}

export interface EdgeReasoningPromptContext {
  selectedNodes?: SelectedNode[];
  cycleInfo?: string;
}

export interface ValidationPromptContext {
  selectedNodes?: SelectedNode[];
  edgeList?: ProposedEdge[];
  validationIssues?: ValidationIssue[];
}

export const EDGE_REASONING_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['orderedNodes', 'edges'],
  properties: {
    orderedNodes: { type: 'array', items: { type: 'string' } },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'target', 'type'],
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  },
};

export const VALIDATION_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['status', 'issues'],
  properties: {
    status: { type: 'string', enum: ['pass', 'fail'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        properties: {
          severity: { type: 'string', enum: ['error', 'warning'] },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
};

export interface IntentPromptResult {
  systemPrompt: string;
  outputSchema: object;
}

const DAG_CONSTRAINTS = `
DAG STRUCTURAL CONSTRAINTS - YOU MUST ENFORCE ALL OF THESE:
1. NO CYCLES: The graph must be a Directed Acyclic Graph. No node may be its own ancestor.
2. EXACTLY ONE TRIGGER: There must be exactly one trigger node. Triggers have in-degree zero (no incoming edges). Triggers are ALWAYS considered reachable - never flag them as orphans.
3. ALL NON-TERMINAL NODES MUST HAVE AT LEAST ONE OUTGOING EDGE: Every node except the final terminal node(s) must connect to a downstream node.
4. BRANCHING NODES (if_else, switch) MUST USE LABELED EDGES:
   - if_else: exactly two outgoing edges - one labeled "true", one labeled "false". Both are required.
   - switch: exactly one outgoing edge per case value, labeled with the actual semantic case value.
5. MERGE NODES: If two or more branches reconverge, they MUST connect to a merge node before continuing.
6. NO ORPHAN NODES: Every non-trigger node must be reachable from the trigger via directed edges. A node is orphaned if no edge points to it (except the trigger itself).
7. LINEAR BY DEFAULT: Unless the user explicitly requests branching/conditions, use a strictly linear chain: trigger -> node1 -> node2 -> ... -> terminal.
8. EVERY EDGE MUST CONNECT CONSECUTIVE NODES: In a linear chain, each edge connects node[i] to node[i+1]. No skipping nodes.
9. COMPLETE COVERAGE: The orderedNodes list and the edges list must be consistent - every node in orderedNodes must appear in at least one edge (as source or target), except the trigger (source only) and terminal (target only).
`.trim();

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
 * Builds the LLM system prompt for the edge-reasoning stage.
 * Mirrors the worker prompt contract: order the selected nodes and propose DAG edges.
 */
export function buildEdgeReasoningPrompt(
  nodeCatalog: string,
  userIntent: string,
  ctx?: EdgeReasoningPromptContext,
): IntentPromptResult {
  const selectedNodesText = ctx?.selectedNodes
    ? JSON.stringify(ctx.selectedNodes, null, 2)
    : '(none provided)';

  const cycleWarning = ctx?.cycleInfo
    ? `\n## CYCLE DETECTED - YOU MUST FIX THIS\nThe previous response contained a cycle: ${ctx.cycleInfo}\nYou MUST return a corrected graph with no cycles.\n`
    : '';

  const systemPrompt = [
    '## ROLE AND OBJECTIVE',
    'You are an execution order and edge reasoning engine for a workflow automation platform.',
    'Your job is to determine the correct execution order and directed edges for the selected nodes.',
    'You MUST produce a complete, connected, acyclic graph where every node is reachable from the trigger.',
    '',
    '## NODE CATALOG',
    nodeCatalog,
    '',
    '## SELECTED NODES',
    selectedNodesText,
    '',
    cycleWarning,
    '## OUTPUT FORMAT',
    'You MUST return ONLY valid JSON conforming exactly to this schema:',
    JSON.stringify(EDGE_REASONING_OUTPUT_SCHEMA, null, 2),
    '',
    '## HARD CONSTRAINTS',
    DAG_CONSTRAINTS,
    '',
    '## NODE ID CONTRACT - READ THIS FIRST',
    'Each node in SELECTED_NODES has a `nodeId` field.',
    'You MUST use these EXACT `nodeId` values - verbatim, character for character - in both `orderedNodes` and every edge `source`/`target`.',
    'NEVER invent a node ID. NEVER abbreviate or modify a node ID. NEVER use the node `type` as an ID.',
    'Copying a UUID or ID incorrectly will break the entire workflow. If unsure, re-read the SELECTED_NODES list.',
    '',
    '## EDGE RULES (MANDATORY)',
    '- orderedNodes MUST list ALL selected node `nodeId` values in execution order (first = trigger, last = terminal).',
    '- edges MUST connect every consecutive pair in orderedNodes: orderedNodes[0]->[1], [1]->[2], etc.',
    '- For a LINEAR workflow with N nodes, you need exactly N-1 edges.',
    '- Use edge type "main" for all normal sequential flow.',
    '- For if_else: replace the single outgoing edge with TWO edges - one type "true", one type "false".',
    '- For switch with K cases: replace the single outgoing edge with K edges.',
    '  CRITICAL: Use the ACTUAL CASE VALUE as the edge type, NOT "case_1"/"case_2".',
    '  Example: switch with cases "high", "medium", "low" -> edges with type "high", "medium", "low".',
    '  Each case value edge connects the switch node to a DIFFERENT downstream node.',
    '  NEVER reuse the same target node for two different case edges.',
    '- For NESTED branching (a switch or if_else that is itself inside a branch of another switch/if_else):',
    '  the inner branching node outgoing edges MUST use the inner switch own case values,',
    '  NOT the outer switch case values. Each level of nesting has its own independent set of case labels.',
    '  Example - nested switch:',
    '    outer_switch -> (case "A") -> inner_switch',
    '    inner_switch -> (case "X") -> node_for_AX',
    '    inner_switch -> (case "Y") -> node_for_AY',
    '    outer_switch -> (case "B") -> node_for_B',
    '  The inner_switch edges use "X" and "Y", NOT "A" or "B".',
    '- For branching terminal logging: each branch MUST connect to its OWN SEPARATE log_output node.',
    '  NEVER share a single log_output across multiple branches.',
    '  If 3 branches each need a log_output, you need 3 separate log_output nodes in orderedNodes.',
    '- NEVER leave a node with no outgoing edge unless it is the last node in orderedNodes.',
    '- NEVER leave a non-trigger node with no incoming edge.',
    '- The trigger node (first in orderedNodes) MUST have exactly one outgoing edge and zero incoming edges.',
    '- Return ONLY the JSON object. No explanation, no markdown, no extra text.',
    '',
    '## SELF-CHECK BEFORE RESPONDING',
    'Before returning your answer, verify:',
    '1. Every string in orderedNodes exactly matches a `nodeId` from SELECTED_NODES - no typos, no extra characters.',
    '2. Every edge `source` and `target` exactly matches a `nodeId` from SELECTED_NODES.',
    '3. Count of edges = count of orderedNodes - 1 (for linear) or more (for branching).',
    '4. Every nodeId in orderedNodes appears in at least one edge.',
    '5. No node appears as a target more than once (except merge nodes).',
    '6. The trigger nodeId is the source of the first edge and never a target.',
    '7. The terminal nodeId is the target of the last edge and never a source.',
    '',
    '## USER INTENT',
    userIntent,
  ].join('\n');

  return { systemPrompt, outputSchema: EDGE_REASONING_OUTPUT_SCHEMA };
}

/**
 * Builds the LLM system prompt for the validation stage.
 * Mirrors the worker prompt contract: validate structure, semantics, completeness, and data flow.
 */
export function buildValidationPrompt(
  nodeCatalog: string,
  userIntent: string,
  ctx?: ValidationPromptContext,
): IntentPromptResult {
  const graphText = ctx?.edgeList
    ? JSON.stringify({ nodes: ctx.selectedNodes, edges: ctx.edgeList }, null, 2)
    : '(graph not provided)';

  const systemPrompt = [
    '## ROLE AND OBJECTIVE',
    'You are a workflow validation engine for a workflow automation platform.',
    'Your job is to validate the assembled workflow graph on FOUR dimensions:',
    '1. STRUCTURAL VALIDITY: Is the graph a valid DAG? Are all edges correctly typed? Is every node reachable from the trigger?',
    '2. SEMANTIC ALIGNMENT: Does the graph actually accomplish what the user asked?',
    '3. COMPLETENESS: Are there any missing required nodes or missing connections?',
    '4. DATA FLOW COHERENCE: Are the outputs of upstream nodes compatible with the inputs of downstream nodes?',
    '',
    '## NODE CATALOG',
    nodeCatalog,
    '',
    '## WORKFLOW GRAPH TO VALIDATE',
    graphText,
    '',
    '## OUTPUT FORMAT',
    'You MUST return ONLY valid JSON conforming exactly to this schema:',
    JSON.stringify(VALIDATION_OUTPUT_SCHEMA, null, 2),
    '',
    '## HARD CONSTRAINTS',
    '- Every "error"-severity issue MUST include a "suggestedFix" field.',
    '- "warning"-severity issues are informational and do not block the workflow.',
    '- If the graph is fully valid on all four dimensions, return status: "pass" with an empty issues array.',
    '- Return ONLY the JSON object. No explanation, no markdown, no extra text.',
    '',
    '## USER INTENT',
    userIntent,
  ].join('\n');

  return { systemPrompt, outputSchema: VALIDATION_OUTPUT_SCHEMA };
}

/**
 * Builds the LLM system prompt for the repair stage.
 * Mirrors the worker prompt contract: return a corrected graph using the edge-reasoning schema.
 */
export function buildRepairPrompt(
  nodeCatalog: string,
  userIntent: string,
  ctx?: ValidationPromptContext,
): IntentPromptResult {
  const issuesText = ctx?.validationIssues
    ? JSON.stringify(ctx.validationIssues, null, 2)
    : '(no issues provided)';

  const graphText = ctx?.edgeList
    ? JSON.stringify({ nodes: ctx.selectedNodes, edges: ctx.edgeList }, null, 2)
    : '(graph not provided)';

  const systemPrompt = [
    '## ROLE AND OBJECTIVE',
    'You are a workflow repair engine for a workflow automation platform.',
    'The workflow graph below has validation errors. Your job is to return a corrected graph.',
    '',
    '## NODE CATALOG',
    nodeCatalog,
    '',
    '## CURRENT WORKFLOW GRAPH (WITH ERRORS)',
    graphText,
    '',
    '## VALIDATION ERRORS TO FIX',
    issuesText,
    '',
    '## OUTPUT FORMAT',
    'Return the corrected workflow graph using the edge reasoning schema:',
    JSON.stringify(EDGE_REASONING_OUTPUT_SCHEMA, null, 2),
    '',
    '## HARD CONSTRAINTS',
    DAG_CONSTRAINTS,
    '',
    '- Fix ALL "error"-severity issues listed above.',
    '- Preserve the user\'s original intent - do not remove nodes unless they are structurally invalid.',
    '- Return ONLY the JSON object. No explanation, no markdown, no extra text.',
    '',
    '## USER INTENT',
    userIntent,
  ].join('\n');

  return { systemPrompt, outputSchema: EDGE_REASONING_OUTPUT_SCHEMA };
}
