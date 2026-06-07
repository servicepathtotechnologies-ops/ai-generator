/**
 * Capability-based node selection type contracts.
 *
 * This mirrors the worker's shared capability type shape without importing
 * worker internals into the ai-generator service.
 */

export type Workflow = unknown;

export interface LlmCallMeta {
  model: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface UseCaseUnit {
  unitId: string;
  label: string;
  semanticRole: 'trigger' | 'data_source' | 'communication' | 'transformation' | 'output' | 'logic';
  description: string;
  orderIndex: number;
}

export interface IntentAnalysisResult {
  ok: true;
  units: UseCaseUnit[];
  promptHash: string;
  durationMs: number;
  llmCall: LlmCallMeta;
}

export interface IntentAnalysisError {
  ok: false;
  code: 'EMPTY_UNIT_LIST' | 'INVALID_LLM_RESPONSE' | 'LLM_CALL_FAILED';
  message: string;
  durationMs: number;
}

export type IntentAnalysisOutput = IntentAnalysisResult | IntentAnalysisError;

export interface CandidateNode {
  nodeType: string;
  label: string;
  description: string;
  credentialRequirements: string[];
  hasCredentials: boolean;
}

export interface CapabilityContainer {
  containerId: string;
  label: string;
  useCaseUnit: UseCaseUnit;
  candidates: CandidateNode[];
}

export interface CapabilityGroupingResult {
  ok: true;
  containers: CapabilityContainer[];
  durationMs: number;
}

export interface CapabilityGroupingError {
  ok: false;
  code: 'EMPTY_CONTAINER' | 'INVALID_LLM_RESPONSE' | 'LLM_CALL_FAILED';
  failedUnitId: string;
  message: string;
  durationMs: number;
}

export interface NodeSelection {
  containerId: string;
  useCaseUnit: UseCaseUnit;
  selectedNodeType: string;
}

export type NodeSelectionMap = Record<string, string>;

export interface StructuralPromptGenerationInput {
  userPrompt: string;
  orderedSelections: NodeSelection[];
  nodeCatalog: string;
  correlationId?: string;
}

export interface StructuralPromptGenerationResult {
  ok: true;
  structuralPrompt: string;
  workflow: Workflow;
  selectedNodeTypes: string[];
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  llmCall: LlmCallMeta;
}

export interface StructuralPromptGenerationError {
  ok: false;
  code: 'INVALID_LLM_RESPONSE' | 'ORCHESTRATOR_VALIDATION_FAILED' | 'LLM_CALL_FAILED';
  message: string;
  durationMs: number;
}
