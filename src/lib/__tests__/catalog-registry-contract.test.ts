/**
 * Day 33 — ai-generator Catalog Registry Contract
 *
 * Validates that createCatalogRegistry parses worker catalog output correctly
 * and that the resulting registry exposes the expected API shape.
 *
 * Uses inline fixture nodes (no worker process needed — CI-independent).
 *
 * Run:
 *   cd services/ai-generator && npm test
 */

import { describe, it, expect } from '@jest/globals';
import { createCatalogRegistry } from '../catalog-registry';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_TRIGGER = {
  type: 'manual_trigger',
  label: 'Manual Trigger',
  category: 'trigger',
  description: 'Manually start a workflow',
  isTrigger: true,
  isBranching: false,
  inputSummary: [],
  outputSummary: ['default'],
  credentials: [],
};

const FIXTURE_ACTION = {
  type: 'google_gmail',
  label: 'Gmail',
  category: 'communication',
  description: 'Send and manage Gmail messages',
  isTrigger: false,
  isBranching: false,
  inputSummary: ['to', 'subject', 'body'],
  outputSummary: ['default'],
  credentials: ['oauth2'],
  tags: ['email', 'google'],
  capabilities: ['email.send'],
  aiKeywords: ['send email', 'gmail'],
};

const FIXTURE_BRANCHING = {
  type: 'if_else',
  label: 'If/Else',
  category: 'logic',
  description: 'Branch based on a condition',
  isTrigger: false,
  isBranching: true,
  inputSummary: ['conditions'],
  outputSummary: ['true', 'false'],
  credentials: [],
};

const FIXTURE_TERMINAL = {
  type: 'log_output',
  label: 'Log Output',
  category: 'utility',
  description: 'Log workflow output',
  isTrigger: false,
  isBranching: false,
  inputSummary: ['message'],
  outputSummary: ['default'],
  credentials: [],
  workflowBehavior: { alwaysTerminal: true },
  isTerminal: true,
  maxOutDegree: 0,
};

const FIXTURE_CATALOG = JSON.stringify([
  FIXTURE_TRIGGER,
  FIXTURE_ACTION,
  FIXTURE_BRANCHING,
  FIXTURE_TERMINAL,
]);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createCatalogRegistry — fixture catalog', () => {
  const registry = createCatalogRegistry(FIXTURE_CATALOG);

  it('getAllTypes returns at least the fixture node types', () => {
    const types = registry.getAllTypes();
    expect(types).toContain('manual_trigger');
    expect(types).toContain('google_gmail');
    expect(types).toContain('if_else');
    expect(types).toContain('log_output');
  });

  it('getAllTypes length matches fixture length', () => {
    expect(registry.getAllTypes().length).toBe(4);
  });

  it('get("manual_trigger") returns the trigger definition', () => {
    const def = registry.get('manual_trigger');
    expect(def).toBeDefined();
    expect(def!.type).toBe('manual_trigger');
    expect(def!.label).toBe('Manual Trigger');
    expect(def!.category).toBe('trigger');
  });

  it('isTrigger("manual_trigger") is true', () => {
    expect(registry.isTrigger('manual_trigger')).toBe(true);
  });

  it('isTrigger("google_gmail") is false', () => {
    expect(registry.isTrigger('google_gmail')).toBe(false);
  });

  it('isTrigger("if_else") is false', () => {
    expect(registry.isTrigger('if_else')).toBe(false);
  });

  it('get("if_else") has isBranching: true', () => {
    const def = registry.get('if_else');
    expect(def!.isBranching).toBe(true);
  });

  it('get("log_output") has isTerminal: true and maxOutDegree: 0', () => {
    const def = registry.get('log_output');
    expect(def!.isTerminal).toBe(true);
    expect(def!.maxOutDegree).toBe(0);
  });

  it('getCategory("google_gmail") returns "communication"', () => {
    expect(registry.getCategory('google_gmail')).toBe('communication');
  });

  it('alias resolution works for label-based lookup', () => {
    // "Gmail" (the label) should resolve to "google_gmail"
    const resolved = registry.resolveAlias('Gmail');
    expect(resolved).toBe('google_gmail');
  });

  it('alias resolution works for underscore variant', () => {
    const resolved = registry.resolveAlias('google_gmail');
    expect(resolved).toBe('google_gmail');
  });

  it('get returns undefined for unknown type', () => {
    expect(registry.get('nonexistent_type_xyz')).toBeUndefined();
  });
});

describe('createCatalogRegistry — malformed input', () => {
  it('empty string produces empty registry without throwing', () => {
    const registry = createCatalogRegistry('');
    expect(() => registry.getAllTypes()).not.toThrow();
    expect(registry.getAllTypes().length).toBe(0);
  });

  it('invalid JSON produces empty registry without throwing', () => {
    const registry = createCatalogRegistry('{not valid json}');
    expect(() => registry.getAllTypes()).not.toThrow();
    expect(registry.getAllTypes().length).toBe(0);
  });

  it('non-array JSON produces empty registry without throwing', () => {
    const registry = createCatalogRegistry('{"key": "value"}');
    expect(() => registry.getAllTypes()).not.toThrow();
    expect(registry.getAllTypes().length).toBe(0);
  });

  it('array with entries missing type are skipped gracefully', () => {
    const catalog = JSON.stringify([
      { label: 'No Type Here', category: 'utility', description: 'test' },
      { type: 'valid_node', label: 'Valid', category: 'logic', description: 'ok' },
    ]);
    const registry = createCatalogRegistry(catalog);
    expect(registry.getAllTypes()).toEqual(['valid_node']);
  });
});

describe('createCatalogRegistry — category-based isTrigger', () => {
  it('nodes with category "triggers" (plural) are also detected as triggers', () => {
    const catalog = JSON.stringify([
      {
        type: 'webhook',
        label: 'Webhook',
        category: 'triggers', // frontend uses plural
        description: 'HTTP webhook trigger',
        isTrigger: false, // explicit false but category overrides
      },
    ]);
    const registry = createCatalogRegistry(catalog);
    expect(registry.isTrigger('webhook')).toBe(true);
  });
});
