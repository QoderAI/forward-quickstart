export const BUILTIN_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ImageSearch', 'ImageGen',
  'DeliverArtifacts',
];

export type ToolPermissionPolicy = 'always_allow' | 'always_ask' | 'always_deny';

export interface ToolApprovalConfig {
  defaultPolicy: ToolPermissionPolicy;
  toolPolicies: Record<string, ToolPermissionPolicy>;
}

export const DEFAULT_TOOL_APPROVAL: ToolApprovalConfig = {
  defaultPolicy: 'always_allow',
  toolPolicies: {},
};

const POLICY_VALUES = new Set<ToolPermissionPolicy>(['always_allow', 'always_ask', 'always_deny']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizePolicy(value: unknown): ToolPermissionPolicy | undefined {
  if (value === 'ask_user' || value === 'default') return 'always_ask';
  return typeof value === 'string' && POLICY_VALUES.has(value as ToolPermissionPolicy)
    ? value as ToolPermissionPolicy
    : undefined;
}

function agentToolset(tools: unknown[] | undefined): Record<string, unknown> | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .map(asRecord)
    .find((tool) => typeof tool?.type === 'string' && tool.type.startsWith('agent_toolset_'));
}

/** Extract user-friendly tool names from a template tools array. */
export function extractToolNames(tools: unknown[] | undefined): string[] {
  const names = [...extractBuiltinToolNames(tools)];
  for (const tool of tools ?? []) {
    const record = asRecord(tool);
    if (record?.type === 'custom' && typeof record.name === 'string') names.push(record.name);
  }
  return Array.from(new Set(names));
}

/** Builtin tool selection restored from a saved template's tools array */
export function extractBuiltinToolNames(tools: unknown[] | undefined): string[] {
  const toolset = agentToolset(tools);
  if (!toolset) return [];
  if (Array.isArray(toolset.enabled_tools)) {
    return toolset.enabled_tools.filter(
      (name): name is string => typeof name === 'string' && BUILTIN_TOOLS.includes(name),
    );
  }
  if (Array.isArray(toolset.configs)) {
    const enabled = toolset.configs
      .map(asRecord)
      .filter((config): config is Record<string, unknown> => !!config && config.enabled !== false)
      .map((config) => config.name)
      .filter((name): name is string => typeof name === 'string' && BUILTIN_TOOLS.includes(name));
    return Array.from(new Set(enabled));
  }
  // A bare toolset means every built-in is enabled (the backend default).
  return [...BUILTIN_TOOLS];
}

/** Read the toolset-wide policy and its per-tool overrides. */
export function extractToolApproval(tools: unknown[] | undefined): ToolApprovalConfig {
  const toolset = agentToolset(tools);
  const defaultConfig = asRecord(toolset?.default_config);
  const defaultPermission = asRecord(defaultConfig?.permission_policy);
  const defaultPolicy = normalizePolicy(defaultPermission?.type) ?? 'always_allow';
  const toolPolicies: Record<string, ToolPermissionPolicy> = {};
  if (Array.isArray(toolset?.configs)) {
    for (const rawConfig of toolset.configs) {
      const config = asRecord(rawConfig);
      const permission = asRecord(config?.permission_policy);
      const policy = normalizePolicy(permission?.type);
      if (typeof config?.name === 'string' && policy) toolPolicies[config.name] = policy;
    }
  }
  return { defaultPolicy, toolPolicies };
}

/** Serialize built-in selection and approval policies using the console wire format. */
export function buildToolsetEntry(
  selectedTools: string[],
  approval: ToolApprovalConfig = DEFAULT_TOOL_APPROVAL,
): Record<string, unknown> {
  const selected = BUILTIN_TOOLS.filter((name) => selectedTools.includes(name));
  const configs = selected.flatMap((name) => {
    const policy = approval.toolPolicies[name];
    return policy && policy !== approval.defaultPolicy
      ? [{ name, permission_policy: { type: policy } }]
      : [];
  });
  return {
    type: 'agent_toolset_20260401',
    enabled_tools: selected,
    default_config: { permission_policy: { type: approval.defaultPolicy } },
    ...(configs.length > 0 ? { configs } : {}),
  };
}
