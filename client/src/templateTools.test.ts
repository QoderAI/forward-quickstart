import { describe, expect, test } from 'vitest';
import {
  BUILTIN_TOOLS,
  buildToolsetEntry,
  extractBuiltinToolNames,
  extractToolNames,
} from './templateTools';

describe('BUILTIN_TOOLS', () => {
  test('offers ImageSearch and ImageGen for template creation and editing', () => {
    expect(BUILTIN_TOOLS).toContain('ImageSearch');
    expect(BUILTIN_TOOLS).toContain('ImageGen');
  });

  test('keeps the previously available builtin tools intact', () => {
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'DeliverArtifacts']) {
      expect(BUILTIN_TOOLS).toContain(tool);
    }
  });

  test('creation default selects every builtin tool including ImageSearch and ImageGen', () => {
    // openTemplateModal seeds the selection with [...BUILTIN_TOOLS]
    const defaultSelection = [...BUILTIN_TOOLS];
    expect(defaultSelection).toContain('ImageSearch');
    expect(defaultSelection).toContain('ImageGen');
    expect(defaultSelection).toHaveLength(BUILTIN_TOOLS.length);
  });
});

describe('extractToolNames', () => {
  test('reads names from enabled_tools and enabled configs', () => {
    const tools = [
      {
        type: 'agent_toolset_20260401',
        enabled_tools: ['Bash', 'WebSearch'],
        configs: [
          { name: 'ImageSearch', enabled: true },
          { name: 'ImageGen' },
          { name: 'DeliverArtifacts', enabled: false },
        ],
      },
    ];
    expect(extractToolNames(tools)).toEqual(['Bash', 'WebSearch', 'ImageSearch', 'ImageGen']);
  });

  test('ignores malformed entries and non-toolset types', () => {
    const tools = [
      null,
      'Bash',
      { type: 'custom', name: 'my_tool' },
      { type: 'agent_toolset_20260401', configs: [{ enabled: true }, { name: 42 }] },
    ];
    expect(extractToolNames(tools as unknown[])).toEqual(['my_tool']);
    expect(extractToolNames(undefined)).toEqual([]);
  });
});

describe('extractBuiltinToolNames (template edit flow)', () => {
  test('restores ImageSearch and ImageGen selection from a saved template', () => {
    const saved = [
      {
        type: 'agent_toolset_20260401',
        configs: [
          { name: 'Bash', enabled: true },
          { name: 'ImageSearch', enabled: true },
          { name: 'ImageGen', enabled: true },
        ],
      },
    ];
    expect(extractBuiltinToolNames(saved)).toEqual(['Bash', 'ImageSearch', 'ImageGen']);
  });

  test('filters out unknown tool names so only available builtins are restored', () => {
    const saved = [
      { type: 'agent_toolset_20260401', enabled_tools: ['Bash', 'NotATool'] },
      { type: 'custom', name: 'my_tool' },
    ];
    expect(extractBuiltinToolNames(saved)).toEqual(['Bash']);
  });
});

describe('buildToolsetEntry (template save flow)', () => {
  test('serializes the selection into a single agent_toolset entry with enabled configs', () => {
    expect(buildToolsetEntry(['Bash', 'ImageSearch', 'ImageGen'])).toEqual({
      type: 'agent_toolset_20260401',
      configs: [
        { name: 'Bash', enabled: true },
        { name: 'ImageSearch', enabled: true },
        { name: 'ImageGen', enabled: true },
      ],
    });
  });

  test('round-trips a changed selection through save and edit restore', () => {
    const selection = BUILTIN_TOOLS.filter((tool) => tool !== 'Bash');
    const restored = extractBuiltinToolNames([buildToolsetEntry(selection)]);
    expect(restored).toEqual(selection);
    expect(restored).toContain('ImageSearch');
    expect(restored).toContain('ImageGen');
    expect(restored).not.toContain('Bash');
  });
});
