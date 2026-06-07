interface CompactCatalogEntry {
  type: string;
  label?: string;
  category?: string;
  description?: string;
  credentials?: string[];
  isTrigger?: boolean;
  isBranching?: boolean;
  operations?: string[];
  tags?: string[];
  capabilities?: string[];
  aiKeywords?: string[];
  useCases?: string[];
  workflowBehavior?: {
    alwaysTerminal?: boolean;
  };
  isTerminal?: boolean;
  maxOutDegree?: number;
}

export interface CatalogNodeDefinition {
  type: string;
  label: string;
  category: string;
  description: string;
  tags: string[];
  capabilities: string[];
  aiSelectionCriteria: {
    keywords: string[];
    useCases: string[];
    whenToUse: string[];
  };
  deprecated?: boolean;
  workflowBehavior?: {
    alwaysTerminal?: boolean;
  };
  isTerminal?: boolean;
  maxOutDegree?: number;
  isTrigger?: boolean;
  isBranching?: boolean;
}

export interface CatalogRegistry {
  get(nodeType: string): CatalogNodeDefinition | undefined;
  getAllTypes(): string[];
  getCategory(nodeType: string): string | undefined;
  isTrigger(nodeType: string): boolean;
  resolveAlias(alias: string): string | undefined;
}

export function createCatalogRegistry(catalog: string): CatalogRegistry {
  const entries = parseCatalog(catalog);
  const byType = new Map<string, CatalogNodeDefinition>();
  const originalTypeByLower = new Map<string, string>();

  for (const entry of entries) {
    const type = String(entry.type || '').trim();
    if (!type) continue;

    const def: CatalogNodeDefinition = {
      type,
      label: String(entry.label || type),
      category: String(entry.category || 'utility'),
      description: String(entry.description || ''),
      tags: arrayOfStrings(entry.tags),
      capabilities: arrayOfStrings(entry.capabilities),
      aiSelectionCriteria: {
        keywords: arrayOfStrings(entry.aiKeywords),
        useCases: arrayOfStrings(entry.useCases),
        whenToUse: [],
      },
      workflowBehavior: entry.workflowBehavior,
      isTerminal: entry.isTerminal,
      maxOutDegree: entry.maxOutDegree,
      isTrigger: entry.isTrigger === true || String(entry.category || '').toLowerCase() === 'trigger',
      isBranching: entry.isBranching === true,
    };

    byType.set(type, def);
    originalTypeByLower.set(type.toLowerCase(), type);
  }

  const aliasIndex = buildAliasIndex([...byType.values()]);

  return {
    get(nodeType: string): CatalogNodeDefinition | undefined {
      const raw = String(nodeType || '').trim();
      if (!raw) return undefined;
      return byType.get(raw) ?? byType.get(originalTypeByLower.get(raw.toLowerCase()) || '');
    },

    getAllTypes(): string[] {
      return [...byType.keys()];
    },

    getCategory(nodeType: string): string | undefined {
      return this.get(nodeType)?.category;
    },

    isTrigger(nodeType: string): boolean {
      const def = this.get(nodeType);
      return def?.isTrigger === true || def?.category === 'trigger' || def?.category === 'triggers';
    },

    resolveAlias(alias: string): string | undefined {
      const raw = String(alias || '').trim();
      if (!raw) return undefined;

      const exact = byType.get(raw) ?? byType.get(originalTypeByLower.get(raw.toLowerCase()) || '');
      if (exact) return exact.type;

      const normalized = normalizeAlias(raw);
      if (!normalized) return undefined;

      const matches = aliasIndex.get(normalized) || [];
      return matches.length === 1 ? matches[0] : undefined;
    },
  };
}

function parseCatalog(catalog: string): CompactCatalogEntry[] {
  try {
    const parsed = JSON.parse(String(catalog || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function buildAliasIndex(defs: CatalogNodeDefinition[]): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const def of defs) {
    addAlias(index, def.type, def.type);
    addAlias(index, def.type.replace(/_/g, ' '), def.type);
    addAlias(index, def.label, def.type);
    addAlias(index, def.label.replace(/\s+/g, '_'), def.type);

    for (const token of deriveTypeTokens(def.type)) {
      addAlias(index, token, def.type);
    }

    for (const tag of def.tags) addAlias(index, tag, def.type);
    for (const capability of def.capabilities) addAlias(index, capability, def.type);
    for (const keyword of def.aiSelectionCriteria.keywords) addAlias(index, keyword, def.type);
    for (const useCase of def.aiSelectionCriteria.useCases) addAlias(index, useCase, def.type);
  }

  return index;
}

function deriveTypeTokens(type: string): string[] {
  const parts = normalizeAlias(type).split(' ').filter((part) => part.length > 2);
  return parts.filter((part) => !GENERIC_ALIAS_TOKENS.has(part));
}

function addAlias(index: Map<string, string[]>, phrase: string, nodeType: string): void {
  const normalized = normalizeAlias(phrase);
  if (!normalized || normalized.length < 2) return;
  const existing = index.get(normalized) || [];
  if (!existing.includes(nodeType)) {
    index.set(normalized, [...existing, nodeType]);
  }
}

function normalizeAlias(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_ALIAS_TOKENS = new Set([
  'api',
  'app',
  'call',
  'data',
  'event',
  'file',
  'http',
  'message',
  'node',
  'request',
  'response',
  'send',
  'service',
  'trigger',
  'webhook',
]);
