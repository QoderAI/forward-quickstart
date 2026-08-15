import { describe, expect, test } from 'vitest';
import {
  buildTemplateBindings,
  buildTemplateModel,
  parseTemplateBindingIds,
  parseTemplateModel,
} from './templateConfig';

describe('template model config', () => {
  test('keeps the legacy string shape when no advanced setting is configured', () => {
    expect(buildTemplateModel(' ultimate ')).toBe('ultimate');
  });

  test('builds and parses the advanced model object', () => {
    const model = buildTemplateModel('ultimate', 'high', 200000);
    expect(model).toEqual({ id: 'ultimate', effort: 'high', context_window: 200000 });
    expect(parseTemplateModel(model)).toEqual({ id: 'ultimate', effort: 'high', contextWindow: 200000 });
  });
});

describe('template resource bindings', () => {
  test('normalizes current and legacy bindings', () => {
    expect(parseTemplateBindingIds({ vault_1: { enabled: true }, vault_2: { enabled: false } })).toEqual(['vault_1']);
    expect(parseTemplateBindingIds(['vault_legacy'])).toEqual(['vault_legacy']);
  });

  test('serializes binding IDs in the console request shape', () => {
    expect(buildTemplateBindings(['file_1', 'file_2'])).toEqual({
      file_1: { enabled: true },
      file_2: { enabled: true },
    });
  });
});
