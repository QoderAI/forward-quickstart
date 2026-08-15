import type { ForwardTemplateModel, TemplateResourceBindings } from './forwardApi';

export interface TemplateModelConfig {
  id: string;
  effort?: string;
  contextWindow?: number;
}

export function parseTemplateModel(model: ForwardTemplateModel | unknown): TemplateModelConfig {
  if (typeof model === 'string') return { id: model };
  if (!model || typeof model !== 'object') return { id: '' };
  const record = model as Record<string, unknown>;
  const contextWindow = typeof record.context_window === 'number'
    && Number.isFinite(record.context_window)
    && record.context_window > 0
    ? record.context_window
    : undefined;
  return {
    id: typeof record.id === 'string' ? record.id : '',
    effort: typeof record.effort === 'string' && record.effort ? record.effort : undefined,
    contextWindow,
  };
}

export function buildTemplateModel(
  id: string,
  effort?: string,
  contextWindow?: number,
): ForwardTemplateModel {
  const cleanId = id.trim();
  const cleanEffort = effort?.trim();
  const cleanContext = typeof contextWindow === 'number'
    && Number.isFinite(contextWindow)
    && contextWindow > 0
    ? Math.floor(contextWindow)
    : undefined;
  return cleanEffort || cleanContext
    ? {
        id: cleanId,
        ...(cleanEffort ? { effort: cleanEffort } : {}),
        ...(cleanContext ? { context_window: cleanContext } : {}),
      }
    : cleanId;
}

/** Normalize current object bindings and legacy string-array responses to enabled IDs. */
export function parseTemplateBindingIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === 'string' && !!id);
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, config]) => {
      if (!config || typeof config !== 'object' || Array.isArray(config)) return true;
      return (config as Record<string, unknown>).enabled !== false;
    })
    .map(([id]) => id);
}

export function buildTemplateBindings(ids: string[]): TemplateResourceBindings {
  return Object.fromEntries(ids.map((id) => [id, { enabled: true }]));
}
