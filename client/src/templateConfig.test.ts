import { describe, expect, test } from 'vitest';
import {
  buildTemplateBindings,
  buildTemplateModel,
  isTemplateCreatableModel,
  parseTemplateBindingIds,
  parseTemplateModel,
  pickTemplateCreatableModelId,
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

  test('does not choose the Auto pseudo-model for template creation', () => {
    const models = [
      { id: 'auto', display_name: 'Auto', is_enabled: true },
      { id: 'qmodel_38max', display_name: 'Qwen3.8-Max', is_enabled: true },
      { id: 'disabled_model', display_name: 'Disabled', is_enabled: false },
    ];

    expect(isTemplateCreatableModel(models[0])).toBe(false);
    expect(isTemplateCreatableModel(models[1])).toBe(true);
    expect(isTemplateCreatableModel(models[2])).toBe(false);
    expect(pickTemplateCreatableModelId(models, 'auto')).toBe('qmodel_38max');
    expect(pickTemplateCreatableModelId(models, 'qmodel_38max')).toBe('qmodel_38max');
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
