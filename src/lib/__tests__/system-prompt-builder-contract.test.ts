/**
 * Day 133 — system-prompt-builder contract
 *
 * Validates the output shape and conditional sections of every builder
 * function without calling any LLM or network endpoint.
 *
 * Run:
 *   cd services/ai-generator && npx jest src/lib/__tests__/system-prompt-builder-contract.test.ts --no-coverage
 */

import { describe, it, expect } from '@jest/globals';
import {
  buildIntentPrompt,
  buildCapabilitySelectionPrompt,
  buildEdgeReasoningPrompt,
  buildValidationPrompt,
  buildRepairPrompt,
  CAPABILITY_SELECTION_OUTPUT_SCHEMA,
  EDGE_REASONING_OUTPUT_SCHEMA,
  VALIDATION_OUTPUT_SCHEMA,
  type SelectedNode,
  type ProposedEdge,
  type ValidationIssue,
} from '../system-prompt-builder';

const STUB_CATALOG = 'manual_trigger: start a workflow\ngoogle_gmail: send email';
const STUB_INTENT = 'when form submitted, send email via Gmail';

// ─── buildIntentPrompt ────────────────────────────────────────────────────────

describe('buildIntentPrompt', () => {
  const { systemPrompt, outputSchema } = buildIntentPrompt(STUB_CATALOG, STUB_INTENT);

  it('returns a systemPrompt string and an outputSchema object', () => {
    expect(typeof systemPrompt).toBe('string');
    expect(typeof outputSchema).toBe('object');
  });

  it('embeds the node catalog in the system prompt', () => {
    expect(systemPrompt).toContain(STUB_CATALOG);
  });

  it('embeds the user intent in the system prompt', () => {
    expect(systemPrompt).toContain(STUB_INTENT);
  });

  it('mentions the intent extraction role', () => {
    expect(systemPrompt).toContain('intent extraction engine');
  });

  it('outputSchema requires intent, triggerType, actions and dataFlows', () => {
    const schema = outputSchema as { required?: string[] };
    expect(schema.required).toEqual(
      expect.arrayContaining(['intent', 'triggerType', 'actions', 'dataFlows']),
    );
  });
});

// ─── buildCapabilitySelectionPrompt ──────────────────────────────────────────

describe('buildCapabilitySelectionPrompt', () => {
  const { systemPrompt, outputSchema } = buildCapabilitySelectionPrompt(STUB_CATALOG, STUB_INTENT);

  it('embeds the node catalog in the system prompt', () => {
    expect(systemPrompt).toContain(STUB_CATALOG);
  });

  it('embeds the user intent in the system prompt', () => {
    expect(systemPrompt).toContain(STUB_INTENT);
  });

  it('mentions the capability-node suggestion role', () => {
    expect(systemPrompt).toContain('capability-node suggestion engine');
  });

  it('outputSchema is CAPABILITY_SELECTION_OUTPUT_SCHEMA', () => {
    expect(outputSchema).toBe(CAPABILITY_SELECTION_OUTPUT_SCHEMA);
  });

  it('outputSchema requires steps', () => {
    const schema = outputSchema as { required?: string[] };
    expect(schema.required).toContain('steps');
  });
});

// ─── buildEdgeReasoningPrompt ─────────────────────────────────────────────────

describe('buildEdgeReasoningPrompt — no ctx', () => {
  const { systemPrompt, outputSchema } = buildEdgeReasoningPrompt(STUB_CATALOG, STUB_INTENT);

  it('defaults selectedNodesText to (none provided)', () => {
    expect(systemPrompt).toContain('(none provided)');
  });

  it('does not include a cycle warning when cycleInfo is absent', () => {
    expect(systemPrompt).not.toContain('CYCLE DETECTED');
  });

  it('outputSchema is EDGE_REASONING_OUTPUT_SCHEMA', () => {
    expect(outputSchema).toBe(EDGE_REASONING_OUTPUT_SCHEMA);
  });
});

describe('buildEdgeReasoningPrompt — with selectedNodes ctx', () => {
  const nodes: SelectedNode[] = [
    { type: 'manual_trigger', role: 'trigger', reason: 'user start', nodeId: 'n1' },
    { type: 'google_gmail', role: 'action', reason: 'send email', nodeId: 'n2' },
  ];
  const { systemPrompt } = buildEdgeReasoningPrompt(STUB_CATALOG, STUB_INTENT, { selectedNodes: nodes });

  it('embeds the selectedNodes JSON in the system prompt', () => {
    expect(systemPrompt).toContain('"nodeId": "n1"');
    expect(systemPrompt).toContain('"nodeId": "n2"');
  });

  it('does not show (none provided) when selectedNodes are supplied', () => {
    expect(systemPrompt).not.toContain('(none provided)');
  });

  it('still has no cycle warning when cycleInfo is absent', () => {
    expect(systemPrompt).not.toContain('CYCLE DETECTED');
  });
});

describe('buildEdgeReasoningPrompt — with cycleInfo ctx', () => {
  const { systemPrompt } = buildEdgeReasoningPrompt(STUB_CATALOG, STUB_INTENT, {
    cycleInfo: 'n1 → n2 → n1',
  });

  it('includes the CYCLE DETECTED warning header', () => {
    expect(systemPrompt).toContain('CYCLE DETECTED');
  });

  it('includes the specific cycle path in the warning', () => {
    expect(systemPrompt).toContain('n1 → n2 → n1');
  });

  it('instructs the model to return a corrected graph', () => {
    expect(systemPrompt).toContain('corrected graph with no cycles');
  });
});

// ─── buildValidationPrompt ────────────────────────────────────────────────────

describe('buildValidationPrompt — no ctx', () => {
  const { systemPrompt, outputSchema } = buildValidationPrompt(STUB_CATALOG, STUB_INTENT);

  it('defaults graphText to (graph not provided)', () => {
    expect(systemPrompt).toContain('(graph not provided)');
  });

  it('outputSchema is VALIDATION_OUTPUT_SCHEMA', () => {
    expect(outputSchema).toBe(VALIDATION_OUTPUT_SCHEMA);
  });
});

describe('buildValidationPrompt — with edgeList ctx', () => {
  const nodes: SelectedNode[] = [
    { type: 'manual_trigger', role: 'trigger', reason: 'start', nodeId: 'n1' },
  ];
  const edges: ProposedEdge[] = [{ source: 'n1', target: 'n2', type: 'main' }];
  const { systemPrompt } = buildValidationPrompt(STUB_CATALOG, STUB_INTENT, {
    selectedNodes: nodes,
    edgeList: edges,
  });

  it('embeds the edge list JSON in the graph section', () => {
    expect(systemPrompt).toContain('"source": "n1"');
    expect(systemPrompt).toContain('"target": "n2"');
  });

  it('does not fall back to (graph not provided)', () => {
    expect(systemPrompt).not.toContain('(graph not provided)');
  });
});

// ─── buildRepairPrompt ────────────────────────────────────────────────────────

describe('buildRepairPrompt — no ctx', () => {
  const { systemPrompt, outputSchema } = buildRepairPrompt(STUB_CATALOG, STUB_INTENT);

  it('defaults issuesText to (no issues provided)', () => {
    expect(systemPrompt).toContain('(no issues provided)');
  });

  it('defaults graphText to (graph not provided)', () => {
    expect(systemPrompt).toContain('(graph not provided)');
  });

  it('outputSchema is EDGE_REASONING_OUTPUT_SCHEMA (repair reuses edge schema)', () => {
    expect(outputSchema).toBe(EDGE_REASONING_OUTPUT_SCHEMA);
  });
});

describe('buildRepairPrompt — with validationIssues and edgeList ctx', () => {
  const nodes: SelectedNode[] = [
    { type: 'manual_trigger', role: 'trigger', reason: 'start', nodeId: 'n1' },
  ];
  const edges: ProposedEdge[] = [{ source: 'n1', target: 'n2', type: 'main' }];
  const issues: ValidationIssue[] = [
    { severity: 'error', description: 'orphan node n3', suggestedFix: 'remove n3' },
  ];
  const { systemPrompt } = buildRepairPrompt(STUB_CATALOG, STUB_INTENT, {
    selectedNodes: nodes,
    edgeList: edges,
    validationIssues: issues,
  });

  it('embeds the validation issues JSON', () => {
    expect(systemPrompt).toContain('orphan node n3');
    expect(systemPrompt).toContain('remove n3');
  });

  it('embeds the workflow graph JSON', () => {
    expect(systemPrompt).toContain('"source": "n1"');
  });

  it('does not use the (no issues provided) placeholder', () => {
    expect(systemPrompt).not.toContain('(no issues provided)');
  });

  it('does not use the (graph not provided) placeholder', () => {
    expect(systemPrompt).not.toContain('(graph not provided)');
  });
});
