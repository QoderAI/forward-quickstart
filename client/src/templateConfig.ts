import type {
  CloudModel,
  CreateTemplateInput,
  ForwardResource,
  ForwardTemplate,
  ForwardTemplateModel,
  TemplateResourceBindings,
} from './forwardApi';

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

export function isTemplateCreatableModel(model: CloudModel): boolean {
  const id = model.id.trim().toLowerCase();
  return !!id && id !== 'auto' && model.is_enabled !== false;
}

export function pickTemplateCreatableModelId(models: CloudModel[], currentId: string): string {
  const creatableModels = models.filter(isTemplateCreatableModel);
  if (creatableModels.some((model) => model.id === currentId)) return currentId;
  return creatableModels[0]?.id ?? currentId;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function equalConfig(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalConfig(value, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => Object.hasOwn(rightRecord, key) && equalConfig(leftRecord[key], rightRecord[key]));
}

function mergeVisibleFields(original: unknown, initial: unknown, draft: unknown): unknown {
  if (equalConfig(initial, draft)) return original;
  const originalRecord = asRecord(original);
  const draftRecord = asRecord(draft);
  const initialRecord = asRecord(initial) ?? (initial === undefined && originalRecord ? {} : undefined);
  if (!initialRecord || !draftRecord) return draft;
  const result = { ...originalRecord };
  for (const key of new Set([...Object.keys(initialRecord), ...Object.keys(draftRecord)])) {
    if (equalConfig(initialRecord[key], draftRecord[key])) continue;
    if (!Object.hasOwn(draftRecord, key)) delete result[key];
    else result[key] = mergeVisibleFields(originalRecord?.[key], initialRecord[key], draftRecord[key]);
  }
  return result;
}

function updateModel(original: ForwardTemplateModel, draft: ForwardTemplateModel): ForwardTemplateModel {
  const originalRecord = asRecord(original);
  const { id } = parseTemplateModel(draft);
  if (!originalRecord || parseTemplateModel(original).id !== id) return draft;
  const result: Record<string, unknown> = { ...originalRecord, ...asRecord(draft), id };
  delete result.effort;
  delete result.context_window;
  const draftRecord = asRecord(draft);
  if (draftRecord?.effort !== undefined) result.effort = draftRecord.effort;
  if (draftRecord?.context_window !== undefined) result.context_window = draftRecord.context_window;
  return result;
}

function skillKey(value: unknown): unknown {
  const record = asRecord(value);
  return record?.skill_id ?? record?.id ?? value;
}

function updateSkills(original: unknown[], initial: unknown[], draft: unknown[]): unknown[] {
  const selected = new Set(draft.map(skillKey));
  const initiallySelected = new Set(initial.map(skillKey));
  return [
    ...draft.map((item) => {
      const saved = original.find((entry) => skillKey(entry) === skillKey(item));
      const record = asRecord(saved);
      if (record && !initiallySelected.has(skillKey(item)) && (record.enabled === false || record.state === 'disabled')) {
        const enabled: Record<string, unknown> = { ...record, enabled: true };
        delete enabled.state;
        return enabled;
      }
      return saved ?? item;
    }),
    ...original.filter((item) => (asRecord(item)?.enabled === false || asRecord(item)?.state === 'disabled')
      && !initiallySelected.has(skillKey(item)) && !selected.has(skillKey(item))),
  ];
}

function bindingRecord(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? buildTemplateBindings(parseTemplateBindingIds(value)) : asRecord(value) ?? {};
}

function updateBindings(original: unknown, initial: unknown, draft: unknown): Record<string, unknown> {
  const saved = bindingRecord(original);
  const baseline = bindingRecord(initial);
  const selected = bindingRecord(draft);
  return Object.fromEntries([
    ...Object.entries(selected).map(([id, config]) => [id, asRecord(saved[id])?.enabled === false && !Object.hasOwn(baseline, id)
      ? { ...asRecord(saved[id]), enabled: true } : saved[id] ?? config]),
    ...Object.entries(saved).filter(([id, config]) => asRecord(config)?.enabled === false
      && !Object.hasOwn(baseline, id) && !Object.hasOwn(selected, id)),
  ]);
}

function agentKey(value: unknown): string {
  const record = asRecord(value);
  return `${record?.type}:${record?.template_id ?? ''}`;
}

function updateMultiagent(original: unknown, initial: unknown, draft: unknown): unknown {
  if (draft === null) return null;
  const saved = asRecord(original);
  const baseline = asRecord(initial);
  const selected = asRecord(draft);
  if (!selected) return draft;
  const originalAgents = Array.isArray(saved?.agents) ? saved.agents : [];
  const initialAgents = Array.isArray(baseline?.agents) ? baseline.agents : [];
  const draftAgents = Array.isArray(selected.agents) ? selected.agents : [];
  const agents = draftAgents.map((item) => {
    const savedItem = originalAgents.find((agent) => agentKey(agent) === agentKey(item));
    if (!savedItem) return item;
    const merged = asRecord(mergeVisibleFields(savedItem,
      initialAgents.find((agent) => agentKey(agent) === agentKey(item)) ?? {}, item));
    const savedRecord = asRecord(savedItem);
    return { ...merged, ...(savedRecord && Object.hasOwn(savedRecord, 'name') ? { name: savedRecord.name } : {}) };
  });
  return {
    ...asRecord(mergeVisibleFields(saved, baseline ?? {}, selected)),
    agents: [
      ...agents,
      ...originalAgents.filter((agent) => asRecord(agent)?.type === 'advisor'
        && !initialAgents.some((item) => agentKey(item) === agentKey(agent))
        && !draftAgents.some((item) => agentKey(item) === agentKey(agent))),
    ],
  };
}

function toolKey(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const type = typeof record.type === 'string' && record.type.startsWith('agent_toolset_')
    ? 'agent_toolset' : record.type;
  return `${type}:${record.name ?? record.id ?? ''}`;
}

function updateToolset(original: Record<string, unknown>, initial: Record<string, unknown>, draft: Record<string, unknown>) {
  const result = { ...asRecord(mergeVisibleFields(original, initial, draft)) };
  const initialEnabled = Array.isArray(initial.enabled_tools) ? initial.enabled_tools : [];
  const draftEnabled = Array.isArray(draft.enabled_tools) ? draft.enabled_tools : [];
  const removed = new Set(initialEnabled.filter((name) => !draftEnabled.includes(name)));
  if (Array.isArray(draft.enabled_tools) && Array.isArray(initial.enabled_tools)) {
    const hidden = Array.isArray(original.enabled_tools)
      ? original.enabled_tools.filter((name) => !initialEnabled.includes(name) && !draftEnabled.includes(name)) : [];
    result.enabled_tools = [...draftEnabled, ...hidden];
  }
  const savedConfigs = Array.isArray(original.configs) ? original.configs : [];
  const initialConfigs = Array.isArray(initial.configs) ? initial.configs : [];
  const draftConfigs = Array.isArray(draft.configs) ? draft.configs : [];
  const configs = draftConfigs.map((config) => {
    const name = asRecord(config)?.name;
    const saved = savedConfigs.find((item) => asRecord(item)?.name === name);
    if (saved === undefined) return config;
    const baseline = initialConfigs.find((item) => asRecord(item)?.name === name);
    const merged = asRecord(mergeVisibleFields(saved, baseline ?? { name }, config));
    return asRecord(saved)?.enabled === false && draftEnabled.includes(name) && !initialEnabled.includes(name)
      ? { ...merged, enabled: true } : merged ?? config;
  });
  for (const config of savedConfigs) {
    const record = asRecord(config);
    const name = record?.name;
    if (removed.has(name) || draftConfigs.some((item) => asRecord(item)?.name === name)) continue;
    const baseline = asRecord(initialConfigs.find((item) => asRecord(item)?.name === name));
    if (!baseline) {
      configs.push(record?.enabled === false && draftEnabled.includes(name) && !initialEnabled.includes(name)
        ? { ...record, enabled: true } : config);
    } else if (Array.isArray(initial.enabled_tools) && draftEnabled.includes(name)
      && Object.keys(baseline).every((key) => key === 'name' || key === 'permission_policy')
      && Object.keys(asRecord(baseline.permission_policy) ?? {}).every((key) => key === 'type')) {
      const policy = asRecord(asRecord(draft.default_config)?.permission_policy);
      configs.push(mergeVisibleFields(config, baseline, { name, permission_policy: policy }));
    }
  }
  if (configs.length > 0 || Array.isArray(draft.configs)) result.configs = configs;
  else delete result.configs;
  return result;
}

function updateTools(original: unknown[], initial: unknown[], draft: unknown[]): unknown[] {
  return draft.map((item) => {
    const saved = original.find((tool) => toolKey(tool) === toolKey(item));
    const baseline = initial.find((tool) => toolKey(tool) === toolKey(item));
    if (saved === undefined) return item;
    if (equalConfig(baseline, item)) return saved;
    const record = asRecord(item);
    const savedRecord = asRecord(saved);
    if (typeof record?.type === 'string' && record.type.startsWith('agent_toolset_') && savedRecord) {
      return updateToolset(savedRecord, asRecord(baseline) ?? {}, record);
    }
    return mergeVisibleFields(saved, baseline ?? {}, item);
  });
}

export function buildTemplateUpdate(
  original: ForwardTemplate,
  initialDraft: CreateTemplateInput,
  draft: CreateTemplateInput,
): Partial<CreateTemplateInput> {
  const baseline = initialDraft as unknown as Record<string, unknown>;
  const selected = draft as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(selected)) {
    if (equalConfig(baseline[key], selected[key])) continue;
    switch (key) {
      case 'model': result.model = updateModel(original.model, draft.model); break;
      case 'skills': result.skills = updateSkills(original.skills ?? [], initialDraft.skills, draft.skills); break;
      case 'files': result.files = updateBindings(original.files, initialDraft.files, draft.files); break;
      case 'vaults': result.vaults = updateBindings(original.vaults ?? original.vault_ids, baseline.vaults, selected.vaults); break;
      case 'multiagent': result.multiagent = updateMultiagent(original.multiagent, initialDraft.multiagent, draft.multiagent); break;
      case 'tools': result.tools = updateTools(original.tools ?? [], initialDraft.tools, draft.tools); break;
      default: result[key] = selected[key];
    }
  }
  return result as Partial<CreateTemplateInput>;
}

export function buildEnvironmentUpdate(
  resource: ForwardResource,
  input: { name: string; description: string; networking: 'limited' | 'unrestricted' },
): { name?: string; description: string; config?: Record<string, unknown> } {
  const config = asRecord(resource.resource_spec?.config);
  const networking = asRecord(config?.networking);
  const initialNetworking = networking?.type === 'unrestricted' ? 'unrestricted' : 'limited';
  const name = input.name.trim();
  return {
    ...(name ? { name } : {}),
    description: input.description.trim(),
    ...(input.networking !== initialNetworking
      ? { config: { ...config, networking: { ...networking, type: input.networking } } } : {}),
  };
}
