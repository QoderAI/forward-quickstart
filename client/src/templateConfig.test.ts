import { describe, expect, test } from 'vitest';
import {
  buildEnvironmentUpdate,
  buildTemplateBindings,
  buildTemplateModel,
  buildTemplateUpdate,
  isTemplateCreatableModel,
  parseTemplateBindingIds,
  parseTemplateModel,
  pickTemplateCreatableModelId,
} from './templateConfig';
import type { CreateTemplateInput, ForwardResource, ForwardTemplate } from './forwardApi';
import {
  buildBrowserToolsetEntry,
  buildToolsetEntry,
  extractBuiltinToolNames,
  extractToolApproval,
} from './templateTools';

function template(overrides: Partial<ForwardTemplate> = {}): ForwardTemplate {
  return { id: 'template_1', name: 'Original', status: 'active', model: 'ultimate', ...overrides };
}

function formInput(overrides: Partial<CreateTemplateInput> = {}): CreateTemplateInput {
  return {
    name: 'Original',
    description: '',
    model: 'ultimate',
    system: '',
    tools: [],
    mcp_servers: [],
    skills: [],
    multiagent: null,
    environment_id: '',
    vaults: {},
    files: {},
    environment_variables: {},
    ...overrides,
  };
}

function multiagent(agents: unknown[], extensions: Record<string, unknown> = {}): NonNullable<ForwardTemplate['multiagent']> {
  return { type: 'coordinator', agents, ...extensions } as NonNullable<ForwardTemplate['multiagent']>;
}

function environment(config?: Record<string, unknown>): ForwardResource {
  return {
    id: 'env_1',
    type: 'environment',
    owner_type: 'user',
    owner_id: 'user_1',
    name: 'Original',
    description: '',
    resource_spec: { config },
  };
}

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
    expect(pickTemplateCreatableModelId(models, 'ultimate')).toBe('qmodel_38max');
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

describe('template partial updates', () => {
  test('a rename omits every normalized but unchanged advanced field', () => {
    const original = template({
      model: { id: 'ultimate', speed: 'fast', effort: 'high', context_window: 200000 },
      tools: [{ type: 'agent_toolset_20260401', permissions: { write: false } }],
      skills: [{ type: 'custom', skill_id: 'skill_1', version: 7, enabled: false }],
      files: { file_1: { enabled: false, path: '/data' } },
      vaults: { vault_1: { enabled: false } },
      multiagent: multiagent([{ type: 'advisor', model: { id: 'ultimate', speed: 'fast' } }]),
    });
    const initial = formInput({
      model: { id: 'ultimate', effort: 'high', context_window: 200000 },
      tools: [buildToolsetEntry(extractBuiltinToolNames(original.tools), extractToolApproval(original.tools))],
    });
    expect(buildTemplateUpdate(original, initial, { ...initial, name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(buildTemplateUpdate(original, initial, structuredClone(initial))).toEqual({});
  });

  test('compares normalized object content without depending on key order', () => {
    const initial = formInput({ model: { id: 'ultimate', effort: 'high' } });
    expect(buildTemplateUpdate(template(), initial, { ...initial, model: { effort: 'high', id: 'ultimate' } })).toEqual({});
  });

  test('only sends ordinary fields that really changed, including explicit clears', () => {
    const initial = formInput({ description: 'Old', system: 'Old system', environment_id: 'env_1' });
    expect(buildTemplateUpdate(template(), initial, {
      ...initial, description: '', system: 'New system', environment_id: 'env_2',
    })).toEqual({ description: '', system: 'New system', environment_id: 'env_2' });
  });

  test('uses the latest original extensions when tuning the same model', () => {
    const original = template({
      model: { id: 'ultimate', speed: 'fast', effort: 'high', context_window: 200000, routing: { region: 'cn' } },
    });
    const initial = formInput({ model: buildTemplateModel('ultimate', 'high', 200000) });
    expect(buildTemplateUpdate(original, initial, { ...initial, model: buildTemplateModel('ultimate', 'low', 200000) })).toEqual({
      model: { id: 'ultimate', speed: 'fast', effort: 'low', context_window: 200000, routing: { region: 'cn' } },
    });
  });

  test.each([
    [buildTemplateModel('ultimate', undefined, 100000), { id: 'ultimate', speed: 'fast', context_window: 100000 }],
    [buildTemplateModel('ultimate', 'low'), { id: 'ultimate', speed: 'fast', effort: 'low' }],
    ['ultimate', { id: 'ultimate', speed: 'fast' }],
  ])('clears removed model tuning without restoring it', (model, expected) => {
    const original = template({ model: { id: 'ultimate', speed: 'fast', effort: 'high', context_window: 200000 } });
    const initial = formInput({ model: buildTemplateModel('ultimate', 'high', 200000) });
    expect(buildTemplateUpdate(original, initial, { ...initial, model })).toEqual({ model: expected });
  });

  test.each(['other_model', buildTemplateModel('other_model', 'high', 100000)])('does not carry speed to another model', (model) => {
    const original = template({ model: { id: 'ultimate', speed: 'fast', routing: 'old' } });
    const initial = formInput();
    expect(buildTemplateUpdate(original, initial, { ...initial, model })).toEqual({ model });
  });

  test('retains selected skill versions and hidden disabled skills but removes active deselections', () => {
    const kept = { type: 'builtin', skill_id: 'keep', version: 9, enabled: true, config: { mode: 'safe' } };
    const hidden = { type: 'custom', skill_id: 'hidden', version: 4, enabled: false };
    const original = template({ skills: [kept, { type: 'custom', skill_id: 'remove', version: 3 }, hidden] });
    const initial = formInput({ skills: [{ type: 'custom', skill_id: 'keep' }, { type: 'custom', skill_id: 'remove' }] });
    const added = { type: 'custom', skill_id: 'new', version: 2 };
    expect(buildTemplateUpdate(original, initial, { ...initial, skills: [{ type: 'custom', skill_id: 'keep' }, added] })).toEqual({
      skills: [kept, added, hidden],
    });
    expect(buildTemplateUpdate(original, initial, { ...initial, skills: [] })).toEqual({ skills: [hidden] });
  });

  test('explicitly selecting a disabled skill enables it and preserves its version', () => {
    const disabled = { type: 'custom', skill_id: 'disabled', version: 8, enabled: false };
    const hidden = { type: 'custom', skill_id: 'hidden', version: 2, state: 'disabled' };
    const initial = formInput();
    expect(buildTemplateUpdate(template({ skills: [disabled, hidden] }), initial, {
      ...initial, skills: [{ type: 'custom', skill_id: 'disabled' }],
    })).toEqual({ skills: [{ ...disabled, enabled: true }, hidden] });
    expect(buildTemplateUpdate(template({ skills: [hidden] }), initial, {
      ...initial, skills: [{ type: 'custom', skill_id: 'hidden' }],
    })).toEqual({ skills: [{ type: 'custom', skill_id: 'hidden', version: 2, enabled: true }] });
  });

  test.each(['files', 'vaults'] as const)('explicitly selecting a disabled %s binding enables it', (field) => {
    const initial = formInput();
    expect(buildTemplateUpdate(template({ [field]: { disabled: { enabled: false, path: '/preserved' } } }), initial, {
      ...initial, [field]: buildTemplateBindings(['disabled']),
    })).toEqual({ [field]: { disabled: { enabled: true, path: '/preserved' } } });
  });

  test('does not restore a disabled skill explicitly removed from the visible selection', () => {
    const original = template({ skills: [{ type: 'custom', skill_id: 'disabled', enabled: false, version: 2 }] });
    const initial = formInput({ skills: [{ type: 'custom', skill_id: 'disabled' }] });
    expect(buildTemplateUpdate(original, initial, { ...initial, skills: [] })).toEqual({ skills: [] });
  });

  test.each(['files', 'vaults'] as const)('preserves %s item configs and hidden disabled bindings', (field) => {
    const kept = { enabled: true, path: '/data', permissions: { write: false } };
    const hidden = { enabled: false, path: '/hidden' };
    const original = template({ [field]: { keep: kept, remove: { enabled: true }, hidden } });
    const initial = formInput({ [field]: buildTemplateBindings(['keep', 'remove']) });
    expect(buildTemplateUpdate(original, initial, { ...initial, [field]: buildTemplateBindings(['keep', 'new']) })).toEqual({
      [field]: { keep: kept, new: { enabled: true }, hidden },
    });
    expect(buildTemplateUpdate(original, initial, { ...initial, [field]: {} })).toEqual({ [field]: { hidden } });
  });

  test('a disabled binding shown in the form can be explicitly removed', () => {
    const initial = formInput({ files: buildTemplateBindings(['disabled']) });
    expect(buildTemplateUpdate(template({ files: { disabled: { enabled: false } } }), initial, { ...initial, files: {} })).toEqual({ files: {} });
  });

  test('legacy vault responses are updated using only the vaults wire key', () => {
    const original = template({ vault_ids: ['keep', 'remove'] });
    const initial = formInput({ vaults: buildTemplateBindings(['keep', 'remove']) });
    expect(buildTemplateUpdate(original, initial, { ...initial, vaults: buildTemplateBindings(['keep']) })).toEqual({
      vaults: { keep: { enabled: true } },
    });
  });

  test('keeps Advisor and existing agent names and extensions while honoring roster deletions', () => {
    const advisor = { type: 'advisor', model: { id: 'ultimate', speed: 'fast' }, config: { enabled: true } };
    const kept = { type: 'agent', template_id: 'keep', name: 'Custom name', permissions: { delegate: true } };
    const original = template({ multiagent: multiagent([
      kept, { type: 'agent', template_id: 'remove', name: 'Remove' }, { type: 'self', extra: true }, advisor,
    ], { strategy: 'parallel' }) });
    const initial = formInput({ multiagent: multiagent([
      { type: 'agent', template_id: 'keep', name: 'Current name' },
      { type: 'agent', template_id: 'remove', name: 'Remove' }, { type: 'self' },
    ]) });
    const added = { type: 'agent', template_id: 'new', name: 'New' };
    expect(buildTemplateUpdate(original, initial, { ...initial, multiagent: multiagent([
      { type: 'agent', template_id: 'keep', name: 'Current name' }, added,
    ]) })).toEqual({ multiagent: { type: 'coordinator', strategy: 'parallel', agents: [kept, added, advisor] } });
  });

  test('an explicit null disables multiagent including Advisor', () => {
    const original = template({ multiagent: multiagent([{ type: 'self' }, { type: 'advisor', model: 'ultimate' }]) });
    const initial = formInput({ multiagent: multiagent([{ type: 'self' }]) });
    expect(buildTemplateUpdate(original, initial, { ...initial, multiagent: null })).toEqual({ multiagent: null });
  });

  test('an unchanged Advisor-only null projection is not submitted', () => {
    const original = template({ multiagent: multiagent([{ type: 'advisor', model: 'ultimate' }]) });
    const initial = formInput();
    expect(buildTemplateUpdate(original, initial, { ...initial, description: 'Updated' })).toEqual({ description: 'Updated' });
    expect(buildTemplateUpdate(original, initial, { ...initial, multiagent: multiagent([{ type: 'self' }]) })).toEqual({
      multiagent: multiagent([{ type: 'self' }, { type: 'advisor', model: 'ultimate' }]),
    });
  });

  test('does not restore an Advisor explicitly present then removed from the draft', () => {
    const config = multiagent([{ type: 'self' }, { type: 'advisor', model: 'ultimate' }]);
    const initial = formInput({ multiagent: config });
    expect(buildTemplateUpdate(template({ multiagent: config }), initial, { ...initial, multiagent: multiagent([{ type: 'self' }]) })).toEqual({
      multiagent: multiagent([{ type: 'self' }]),
    });
  });
});

describe('template tool updates', () => {
  test('preserves hidden configs, restrictions, permissions and toolset version without overwriting visible edits', () => {
    const keptConfig = { name: 'Bash', enabled: true, disallowed: ['rm'], permission_policy: { type: 'always_ask', scope: 'workspace' } };
    const hiddenConfig = { name: 'HiddenTool', enabled: false, permissions: { write: false } };
    const original = template({ tools: [{
      type: 'agent_toolset_20260101',
      enabled_tools: ['Bash', 'Read', 'HiddenActive'],
      default_config: { permission_policy: { type: 'always_allow', paths: ['/tmp'] }, permissions: { network: false } },
      disallowed: ['sudo'],
      permissions: { write: false },
      configs: [keptConfig, { name: 'Read', enabled: true, permissions: { read: true } }, hiddenConfig],
    }] });
    const initial = formInput({ tools: [buildToolsetEntry(extractBuiltinToolNames(original.tools), extractToolApproval(original.tools))] });
    const draft = { ...initial, tools: [buildToolsetEntry(['Bash', 'Write'], {
      defaultPolicy: 'always_deny', toolPolicies: { Bash: 'always_allow' },
    })] };
    expect(buildTemplateUpdate(original, initial, draft)).toEqual({ tools: [{
      type: 'agent_toolset_20260101',
      enabled_tools: ['Bash', 'Write', 'HiddenActive'],
      default_config: { permission_policy: { type: 'always_deny', paths: ['/tmp'] }, permissions: { network: false } },
      disallowed: ['sudo'],
      permissions: { write: false },
      configs: [{ ...keptConfig, permission_policy: { type: 'always_allow', scope: 'workspace' } }, hiddenConfig],
    }] });
  });

  test('adding a per-tool override preserves previously unshown permission extensions', () => {
    const original = template({ tools: [{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Bash', permission_policy: { type: 'always_allow', scope: 'workspace' }, disallowed: ['sudo'] }],
    }] });
    const initial = formInput({ tools: [buildToolsetEntry(['Bash'])] });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [buildToolsetEntry(['Bash'], {
      defaultPolicy: 'always_allow', toolPolicies: { Bash: 'always_deny' },
    })] }).tools).toEqual([{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Bash', permission_policy: { type: 'always_deny', scope: 'workspace' }, disallowed: ['sudo'] }],
    }]);
  });

  test('a new per-tool config keeps its name and the draft policy', () => {
    const original = template({ tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Bash'] }] });
    const initial = formInput({ tools: [buildToolsetEntry(['Bash'])] });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [buildToolsetEntry(['Bash', 'Read'], {
      defaultPolicy: 'always_allow', toolPolicies: { Read: 'always_ask' },
    })] }).tools).toEqual([{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash', 'Read'],
      configs: [{ name: 'Read', permission_policy: { type: 'always_ask' } }],
    }]);
  });

  test('per-tool JSON restrictions are changed without losing unshown permission fields', () => {
    const original = template({ tools: [{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Bash', disallowed: ['sudo'], permission_policy: { type: 'always_ask', scope: 'workspace' } }],
    }] });
    const initial = formInput({ tools: [{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Bash', disallowed: ['sudo'], permission_policy: { type: 'always_ask' } }],
    }] });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Bash', disallowed: ['rm'], permission_policy: { type: 'always_deny' } }],
    }] }).tools).toEqual([{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Bash', disallowed: ['rm'], permission_policy: { type: 'always_deny', scope: 'workspace' } }],
    }]);
  });

  test('clearing an override applies the default policy rather than restoring the old override', () => {
    const original = template({ tools: [{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Bash', permission_policy: { type: 'always_deny', scope: 'workspace' }, permissions: { write: false } }],
    }] });
    const initial = formInput({ tools: [buildToolsetEntry(['Bash'], {
      defaultPolicy: 'always_allow', toolPolicies: { Bash: 'always_deny' },
    })] });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [buildToolsetEntry(['Bash'])] }).tools).toEqual([{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Bash', permission_policy: { type: 'always_allow', scope: 'workspace' }, permissions: { write: false } }],
    }]);
  });

  test('explicitly selecting a previously disabled tool does not leave its config disabled', () => {
    const original = template({ tools: [{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash'],
      configs: [{ name: 'Read', enabled: false, disallowed: ['/secret'] }],
    }] });
    const initial = formInput({ tools: [buildToolsetEntry(['Bash'])] });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [buildToolsetEntry(['Bash', 'Read'])] }).tools).toEqual([{
      type: 'agent_toolset_20260401', enabled_tools: ['Bash', 'Read'],
      configs: [{ name: 'Read', enabled: true, disallowed: ['/secret'] }],
    }]);
  });

  test('does not restore explicitly removed toolsets, browser tools or custom tools', () => {
    const original = template({ tools: [
      { type: 'agent_toolset_20260401', enabled_tools: ['Bash'], permissions: { write: false } },
      { type: 'browser_toolset_20260714', config: { beta: true } },
      { type: 'custom', name: 'custom', config: { old: true } },
    ] });
    const initial = formInput({ tools: [buildToolsetEntry(['Bash']), buildBrowserToolsetEntry(), original.tools![2]] });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [] })).toEqual({ tools: [] });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [buildToolsetEntry(['Bash'])] })).toEqual({ tools: [original.tools![0]] });
  });

  test('explicit JSON config edits and deletions win over original values', () => {
    const original = template({ tools: [{ type: 'custom', name: 'custom', config: { timeout: 10, removed: true }, permissions: { write: false } }] });
    const initial = formInput({ tools: structuredClone(original.tools!) });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [{
      type: 'custom', name: 'custom', config: { timeout: 20 }, permissions: { write: true },
    }] })).toEqual({ tools: [{ type: 'custom', name: 'custom', config: { timeout: 20 }, permissions: { write: true } }] });
  });

  test('removes configs explicitly deleted from a full JSON toolset input', () => {
    const original = template({ tools: [{
      type: 'agent_toolset_20260401', configs: [{ name: 'Bash', enabled: true, disallowed: ['sudo'] }],
    }] });
    const initial = formInput({ tools: structuredClone(original.tools!) });
    expect(buildTemplateUpdate(original, initial, { ...initial, tools: [{ type: 'agent_toolset_20260401', configs: [] }] })).toEqual({
      tools: [{ type: 'agent_toolset_20260401', configs: [] }],
    });
  });

  test('does not mutate any input when another tool changes and a toolset stays normalized', () => {
    const original = template({ tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Bash'], configs: [{ name: 'Bash', enabled: true }] }] });
    const initial = formInput({ tools: [buildToolsetEntry(['Bash'])] });
    const draft = { ...initial, tools: [...initial.tools, buildBrowserToolsetEntry()] };
    const snapshots = structuredClone([original, initial, draft]);
    Object.freeze(original.tools![0]);
    expect(buildTemplateUpdate(original, initial, draft).tools).toEqual([...original.tools!, buildBrowserToolsetEntry()]);
    expect([original, initial, draft]).toEqual(snapshots);
  });
});

describe('environment partial updates', () => {
  test('a name-only edit omits config, including write-only and OSS Beta fields', () => {
    const resource = environment({
      type: 'cloud', networking: { type: 'limited', allowed_domains: ['example.com'] },
      storage: { type: 'oss', write_only: 'secret' }, packages: ['git'], scripts: ['setup'],
    });
    expect(buildEnvironmentUpdate(resource, { name: ' Renamed ', description: '', networking: 'limited' })).toEqual({
      name: 'Renamed', description: '',
    });
  });

  test.each(['cloud', 'selfhosted'])('a network change retains the complete %s config and networking extensions', (type) => {
    const config = {
      type, networking: { type: 'limited', allowed_domains: ['example.com'] },
      packages: ['git'], scripts: { setup: 'npm install' }, storage: { type: 'oss', bucket: 'bucket' },
      endpoint: 'https://runner.example.com', extensions: { keep: true },
    };
    const resource = environment(config);
    const snapshot = structuredClone(resource);
    expect(buildEnvironmentUpdate(resource, { name: 'Renamed', description: ' Updated ', networking: 'unrestricted' })).toEqual({
      name: 'Renamed', description: 'Updated',
      config: { ...config, networking: { ...config.networking, type: 'unrestricted' } },
    });
    expect(resource).toEqual(snapshot);
  });

  test('a selfhosted rename never rewrites it as cloud', () => {
    expect(buildEnvironmentUpdate(environment({ type: 'selfhosted', networking: { type: 'unrestricted' } }), {
      name: 'Renamed', description: '', networking: 'unrestricted',
    })).toEqual({ name: 'Renamed', description: '' });
  });

  test('missing networking follows the form default without synthesizing cloud config', () => {
    expect(buildEnvironmentUpdate(environment(), { name: 'Renamed', description: '', networking: 'limited' })).toEqual({
      name: 'Renamed', description: '',
    });
    expect(buildEnvironmentUpdate(environment({ type: 'selfhosted', packages: ['git'] }), {
      name: '', description: '', networking: 'unrestricted',
    })).toEqual({ description: '', config: { type: 'selfhosted', packages: ['git'], networking: { type: 'unrestricted' } } });
  });
});
