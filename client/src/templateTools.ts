/** Extract user-friendly built-in tool names from template tools array */
export function extractToolNames(tools: unknown[] | undefined): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const record = tool as Record<string, unknown>;
    if (record.type === 'agent_toolset_20260401') {
      // Extract from enabled_tools (convenience allowlist)
      if (Array.isArray(record.enabled_tools)) {
        names.push(...record.enabled_tools.filter((t): t is string => typeof t === 'string'));
      }
      // Extract from configs (per-tool {name, enabled} objects)
      if (Array.isArray(record.configs)) {
        for (const config of record.configs) {
          if (config && typeof config === 'object') {
            const c = config as Record<string, unknown>;
            if (typeof c.name === 'string' && c.enabled !== false) {
              names.push(c.name);
            }
          }
        }
      }
    }
    if (record.type === 'custom' && typeof record.name === 'string') {
      names.push(record.name);
    }
  }
  return names;
}

export const BUILTIN_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ImageSearch', 'ImageGen',
  'DeliverArtifacts',
];

/** Builtin tool selection restored from a saved template's tools array */
export function extractBuiltinToolNames(tools: unknown[] | undefined): string[] {
  return extractToolNames(tools).filter((name) => BUILTIN_TOOLS.includes(name));
}

/** Serialize the builtin tool selection into the agent_toolset tools entry */
export function buildToolsetEntry(selectedTools: string[]): Record<string, unknown> {
  return {
    type: 'agent_toolset_20260401',
    configs: selectedTools.map((name) => ({ name, enabled: true })),
  };
}
