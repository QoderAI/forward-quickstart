import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  cancelSession,
  createCloudEnvironment,
  createCloudVault,
  createSession,
  deleteCloudFile,
  getCloudFile,
  downloadCloudFile,
  type CloudFile,
  deleteCloudSkill,
  deleteCloudEnvironment,
  deleteCloudVault,
  uploadCloudSkill,
  uploadCloudFile,
  updateCloudEnvironment,
  updateCloudSkill,
  listCloudSkills,
  listCloudCredentials,
  createCloudCredential,
  deleteCloudCredential,
  type CloudModel,
  listCloudModels,
  createTemplate,
  updateTemplate,
  ensureIdentity,
  listEvents,
  listResources,
  listSessions,
  listTemplates,
  registerResource,
  addSessionFileResource,
  deleteForwardResource,
  ForwardApiError,
  sendUserMessage,
  streamEvents,
  listSchedules,
  createSchedule,
  updateSchedule,
  archiveSchedule,
  runSchedule,
  getScheduleRun,
  listMemoryEntries,
  getMemoryEntry,
  getEffectiveSpec,
  pauseSchedule,
  unpauseSchedule,
  listChannels,
  createChannel,
  updateChannel,
  createQrSession,
  getQrSession,
  deleteChannel,
  buildChannelCredentials,
  waitForChannelBinding,
  listManagedAgents,
  type ManagedAgent,
  type MultiagentConfig,
  type MultiagentAgentEntry,
  type ForwardChannel,
  type ForwardQrSession,
  type ChannelType,
  type ForwardSchedule,
  type CreateScheduleInput,
  type ForwardApiEnvironment,
  type ForwardContext,
  type ForwardEvent,
  type ForwardIdentity,
  type ForwardResource,
  type ForwardResourceType,
  type ForwardSession,
  type ForwardTemplate,
} from './forwardApi';
import { renderMarkdown } from './markdown';
import { ChatImage } from './chatImage';
import { isImageFile } from './imageUtils';
import { PRODUCT_NAME } from './config/product';

// Helpers for the multiagent roster form state.
const AUTH_KEY = 'forward_quickstart_auth';
const FORWARD_ICON = '/forward-icon.png';

// Accumulate thinking_delta from incremental streaming per session.
// The Forward API's agent.thinking event has no content — thinking text
// is only delivered via agent.content_block_delta with delta.type "thinking_delta".
const _thinkingBySession = new Map<string, string>();
// Streaming text accumulators for real-time agent message display
const _streamingTextBySession = new Map<string, string>();
const _streamingMsgIdBySession = new Map<string, string>();
/** Extract user-friendly built-in tool names from template tools array */
function extractToolNames(tools: unknown[] | undefined): string[] {
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

/** Extract MCP server display names from template */
function extractMcpNames(mcpServers: unknown[] | undefined): string[] {
  if (!Array.isArray(mcpServers)) return [];
  return mcpServers
    .filter((s): s is Record<string, unknown> => s != null && typeof s === 'object' && typeof (s as Record<string, unknown>).name === 'string')
    .map((s) => s.name as string);
}

/** Extract skill display info from template */
function extractSkillInfo(skills: unknown[] | undefined): Array<{ id: string; name: string; enabled: boolean }> {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((s): s is Record<string, unknown> => s != null && typeof s === 'object')
    .map((s) => ({
      id: String(s.skill_id ?? s.id ?? ''),
      name: String(s.name ?? s.skill_id ?? s.id ?? ''),
      enabled: s.enabled !== false && s.state !== 'disabled',
    }));
}

const BUILTIN_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'DeliverArtifacts',
];

const CHANNEL_TYPES: Array<{ value: ChannelType; label: string; icon: string; qrSupport: boolean; manualSupport: boolean }> = [
  { value: 'wechat', label: '微信', icon: '💬', qrSupport: true, manualSupport: false },
  { value: 'wecom', label: '企业微信', icon: '🏢', qrSupport: true, manualSupport: true },
  { value: 'dingtalk', label: '钉钉', icon: '📌', qrSupport: true, manualSupport: true },
  { value: 'feishu', label: '飞书', icon: '🐦', qrSupport: true, manualSupport: true },
];

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  ultimate: '旗舰版',
  performance: '高性能版',
  lite: '轻量版',
};

function getTemplateModelId(model: ForwardTemplate['model'] | unknown): string {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    const id = (model as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }
  return '';
}

function fileCount(files: unknown): number {
  if (!files || typeof files !== 'object') return 0;
  return Object.keys(files as Record<string, unknown>).length;
}

// ─── Resource helpers ──────────────────────────────────────────────

const RESOURCE_ICONS: Record<ForwardResourceType, string> = {
  skill: '⚡',
  file: '📄',
  environment: '🖥',
  vault: '🔐',
  memory_store: '🧠',
};

function specField(resource: ForwardResource, ...keys: string[]): unknown {
  const spec = resource.resource_spec;
  if (!spec || typeof spec !== 'object') return undefined;
  const record = spec as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  return undefined;
}

function specString(resource: ForwardResource, ...keys: string[]): string {
  const v = specField(resource, ...keys);
  return typeof v === 'string' ? v : '';
}

function specNumber(resource: ForwardResource, ...keys: string[]): number | undefined {
  const v = specField(resource, ...keys);
  return typeof v === 'number' ? v : undefined;
}

function formatFileSize(bytes?: number): string {
  if (bytes == null || bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resourceSubtitle(resource: ForwardResource): string {
  switch (resource.type) {
    case 'skill':
      return specString(resource, 'description') || '技能';
    case 'file': {
      const size = specNumber(resource, 'size_bytes');
      const mime = specString(resource, 'mime_type');
      return [size != null ? formatFileSize(size) : '', mime].filter(Boolean).join(' · ') || '文件';
    }
    case 'environment': {
      const networking = specField(resource, 'networking') as { type?: string } | undefined;
      return networking?.type === 'unrestricted' ? '完全开放网络' : '受限网络';
    }
    case 'vault':
      return '凭据库';
    case 'memory_store':
      return specString(resource, 'description') || '记忆库';
    default:
      return '';
  }
}

const API_ENV_OPTIONS: Array<{ value: ForwardApiEnvironment; label: string }> = [
  { value: 'cn-prod', label: '中国站' },
  { value: 'global-prod', label: '国际站' },
];

function isForwardApiEnvironment(value: unknown): value is ForwardApiEnvironment {
  return value === 'cn-prod' || value === 'global-prod';
}

function readSavedAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return { pat: '', externalId: '', apiEnvironment: 'cn-prod' as ForwardApiEnvironment };
    const saved = JSON.parse(raw);
    return {
      apiEnvironment: isForwardApiEnvironment(saved.apiEnvironment) ? saved.apiEnvironment : 'cn-prod',
      pat: typeof saved.pat === 'string'
        ? saved.pat
        : typeof saved.userId === 'string'
          ? saved.userId
          : '',
      externalId: typeof saved.externalId === 'string' ? saved.externalId : '',
    };
  } catch {
    return { pat: '', externalId: '', apiEnvironment: 'cn-prod' as ForwardApiEnvironment };
  }
}

const RESOURCE_TYPE_LABELS: Record<ForwardResourceType, string> = {
  skill: '技能',
  file: '文件',
  environment: '环境',
  vault: '凭据库',
  memory_store: '记忆库',
};

const TEMPLATE_RESOURCE_TYPES: ForwardResourceType[] = ['skill', 'file', 'environment', 'vault'];

function emptyResourceOptions(): Record<ForwardResourceType, ForwardResource[]> {
  return {
    skill: [],
    file: [],
    environment: [],
    vault: [],
    memory_store: [],
  };
}

type SidebarPanel = 'chat' | 'schedules' | 'channels' | 'templates' | 'skills' | 'files' | 'environments' | 'vaults' | 'memoryStores' | 'usage';

const SIDEBAR_ITEMS: Array<{ id: SidebarPanel; label: string }> = [
  { id: 'chat', label: '对话' },
  { id: 'templates', label: '模板' },
  { id: 'memoryStores', label: '个人记忆' },
  { id: 'schedules', label: '定时任务' },
  { id: 'channels', label: 'IM 渠道' },
  { id: 'skills', label: '技能' },
  { id: 'files', label: '文件' },
  { id: 'environments', label: '环境' },
  { id: 'vaults', label: '凭据' },
  { id: 'usage', label: '用量' },
];

function resourceTypeForPanel(panel: SidebarPanel): ForwardResourceType | null {
  if (panel === 'skills') return 'skill';
  if (panel === 'files') return 'file';
  if (panel === 'environments') return 'environment';
  if (panel === 'vaults') return 'vault';
  if (panel === 'memoryStores') return 'memory_store';
  return null;
}

function isResourcePanel(panel: SidebarPanel) {
  return resourceTypeForPanel(panel) !== null;
}

function resourceDisplayName(resource: ForwardResource) {
  const name = resource.name || specString(resource, 'display_title', 'display_name', 'filename', 'name');
  return name || resource.id;
}

function resolveResourceName(resources: ForwardResource[], id: string): string {
  const found = resources.find((r) => r.id === id);
  if (found) return resourceDisplayName(found);
  return id;
}

function splitTokens(value: string) {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonArray(value: string, field: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error(`${field} 必须是 JSON 数组`);
  return parsed as unknown[];
}

function parseEnvironmentVariables(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('环境变量必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  }
  return Object.fromEntries(
    trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        if (index <= 0) throw new Error(`环境变量格式错误：${line}`);
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

function sessionTitle(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 'Forward 会话';
  return trimmed.length > 32 ? `${trimmed.slice(0, 32)}...` : trimmed;
}

function roleForEvent(type: string) {
  if (type.startsWith('user.')) return 'user';
  if (type.startsWith('agent.')) return 'agent';
  if (type.startsWith('session.')) return 'session';
  return 'event';
}

function displayTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString();
}

function displayDateTime(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function statusText(status?: string) {
  if (!status) return '';
  const normalized = status.replace(/^status_/, '');
  const labels: Record<string, string> = {
    running: '正在运行中',
    idle: '已完成，回到空闲',
    completed: '已完成，回到空闲',
    failed: '运行失败',
    cancelled: '已取消',
    canceled: '已取消',
    archived: '已归档',
  };
  return labels[normalized] ?? normalized;
}

function normalizeEventMessage(message: string) {
  const trimmed = message.trim();
  if (/^turn (cancelled|canceled)$/i.test(trimmed)) return '已取消';
  return message;
}

function sessionStatusLabel(status?: string) {
  if (!status) return '未知';
  const labels: Record<string, string> = {
    running: '运行中',
    idle: '空闲',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    canceled: '已取消',
    archived: '已归档',
  };
  return labels[status] ?? status;
}

function isSessionOngoing(status?: string) {
  const normalized = status?.replace(/^status_/, '');
  return normalized === 'running' || normalized === 'processing' || normalized === 'canceling' || normalized === 'cancelling';
}

function sessionEndTime(session: ForwardSession) {
  return isSessionOngoing(session.status) ? undefined : session.updated_at;
}

function sessionDuration(session: ForwardSession) {
  // Use stats.duration_seconds from API if available
  if (session.stats?.duration_seconds != null && session.stats.duration_seconds > 0) {
    const seconds = session.stats.duration_seconds;
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  const endTime = sessionEndTime(session);
  if (!session.created_at || !endTime) return '—';

  const start = new Date(session.created_at).getTime();
  const end = new Date(endTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';

  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function sessionStatusBadgeClass(status?: string) {
  const normalized = status?.replace(/^status_/, '');
  if (normalized === 'running' || normalized === 'processing') {
    return 'border-[#B8C3FF] bg-[#EEF1FF] text-[#3550FF]';
  }
  if (normalized === 'failed') {
    return 'border-[#FFD0D0] bg-[#FFF1F1] text-[#D92D20]';
  }
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'canceling' || normalized === 'cancelling') {
    return 'border-[#FFE3B8] bg-[#FFF8ED] text-[#B54708]';
  }
  return 'border-[#DDE2F2] bg-[#F7F8FC] text-black/55';
}

function textFromUnknown(value: unknown, depth = 0): string {
  if (value === undefined || value === null || depth > 4) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromUnknown(item, depth + 1))
      .filter(Boolean)
      .join('')
      .trim();
  }
  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'message', 'thinking', 'reasoning', 'summary', 'delta', 'reason']) {
    const text = textFromUnknown(record[key], depth + 1);
    if (text) return text;
  }
  return '';
}

function eventContentText(event: ForwardEvent) {
  return textFromUnknown(event.content);
}

function eventThinkingText(event: ForwardEvent) {
  const contentText = eventContentText(event);
  if (contentText) return contentText;
  for (const key of ['thinking', 'thought', 'reasoning', 'summary', 'message', 'delta', 'text', 'reason']) {
    const text = textFromUnknown(event[key]);
    if (text) return text;
  }
  return '';
}

type EventViewKind =
  | 'user'
  | 'agent_message'
  | 'agent_thinking'
  | 'tool_use'
  | 'tool_result'
  | 'session_error'
  | 'multiagent_status'
  | 'hidden';

function eventViewKind(event: ForwardEvent): EventViewKind {
  if (event.type === 'user.message') return 'user';
  // session.error must stay visible in the chat: it clears the local thinking
  // bubble, so hiding it would make the turn end silently with no feedback.
  if (event.type === 'session.error') return 'session_error';
  if (event.type === 'agent.message') return 'agent_message';
  if (event.type === 'agent.thinking') return 'agent_thinking';
  if (
    event.type === 'agent.tool_use' ||
    event.type === 'agent.custom_tool_use' ||
    event.type === 'agent.mcp_tool_use'
  ) {
    return 'tool_use';
  }
  if (
    event.type === 'agent.tool_result' ||
    event.type === 'agent.custom_tool_result' ||
    event.type === 'agent.mcp_tool_result'
  ) {
    return 'tool_result';
  }
  // Multiagent thread events — shown as subtle status indicators in the chat
  // so the user can see delegation progress (e.g. "已委派任务给足球经理专家").
  if (
    event.type === 'session.thread_created' ||
    event.type === 'session.thread_status_running' ||
    event.type === 'session.thread_status_idle' ||
    event.type === 'agent.thread_message_sent' ||
    event.type === 'agent.thread_message_received'
  ) {
    return 'multiagent_status';
  }
  return 'hidden';
}

/** Extract a short human-readable label for a multiagent thread event. */
function multiagentEventInfo(event: ForwardEvent): string {
  // Try to pull the agent name from common fields; fall back to generic text.
  const name =
    (typeof event.agent_name === 'string' && event.agent_name) ||
    (typeof event.name === 'string' && event.name) ||
    textFromUnknown(event.content) ||
    '';
  switch (event.type) {
    case 'session.thread_created':
      return name ? `已创建子线程：${name}` : '已创建子线程';
    case 'session.thread_status_running':
      return name ? `${name} 开始执行` : '子线程运行中';
    case 'session.thread_status_idle':
      return name ? `${name} 已完成` : '子线程已完成';
    case 'agent.thread_message_sent':
      return name ? `已委派任务给 ${name}` : '已委派任务给子线程';
    case 'agent.thread_message_received':
      return name ? `已收到 ${name} 的回复` : '已收到子线程回复';
    default:
      return '';
  }
}

function getEventValue(event: ForwardEvent, keys: string[]): unknown {
  for (const key of keys) {
    const value = event[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function getNestedValue(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function stringifyPayload(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Guard against rendering megabyte-scale strings synchronously (e.g. a huge tool
// result payload), which can freeze the main thread / make the tab unresponsive.
const MAX_DISPLAY_CHARS = 50000;
function truncateForDisplay(text: string, max = MAX_DISPLAY_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… [内容过长，已截断显示，共 ${text.length} 字符]`;
}

function eventDebugPayload(event: ForwardEvent) {
  const omitted = new Set([
    'id',
    'type',
    'session_id',
    'turn_id',
    'schema_version',
    'created_at',
    'processed_at',
  ]);
  const payload = Object.fromEntries(
    Object.entries(event).filter((entry) => !omitted.has(entry[0])),
  );
  return Object.keys(payload).length ? payload : undefined;
}

function toolEventName(event: ForwardEvent) {
  const direct = getEventValue(event, ['name', 'tool_name', 'tool', 'function_name']);
  if (typeof direct === 'string') return direct;
  const input = getEventValue(event, ['input', 'arguments', 'parameters']);
  const nested = getNestedValue(input, ['name', 'tool_name']);
  if (typeof nested === 'string') return nested;
  const mcpServer = getEventValue(event, ['mcp_server', 'server_name']);
  if (typeof mcpServer === 'string') return mcpServer;
  if (event.type === 'agent.custom_tool_use' || event.type === 'agent.custom_tool_result') return 'custom_tool';
  if (event.type === 'agent.mcp_tool_use' || event.type === 'agent.mcp_tool_result') return 'mcp_tool';
  return 'tool';
}

function toolEventPayload(event: ForwardEvent) {
  const value = getEventValue(event, [
    'input',
    'arguments',
    'parameters',
    'output',
    'result',
    'content',
    'error',
    'reason',
  ]);
  return truncateForDisplay(stringifyPayload(value || eventDebugPayload(event)));
}

function toolEventId(event: ForwardEvent) {
  const value = getEventValue(event, [
    'tool_use_id',
    'custom_tool_use_id',
    'mcp_tool_use_id',
    'tool_call_id',
  ]);
  return typeof value === 'string' ? value : '';
}

/**
 * Extract Cloud file ids (file_...) produced by the DeliverArtifacts tool from a
 * tool_result event. The exact field path varies, so we scan the serialized
 * output/result/content payload for file id tokens and dedupe them.
 */
function extractArtifactFileIds(event: ForwardEvent): string[] {
  const raw = stringifyPayload(
    getEventValue(event, ['output', 'result', 'content']) ?? eventDebugPayload(event),
  );
  if (!raw) return [];
  // Cap the scanned length so a huge tool result can't make the regex scan expensive.
  const scan = raw.length > 200000 ? raw.slice(0, 200000) : raw;
  // Real Cloud file ids look like `file_00iyui42qpz40fqtdh45` (prefix + long
  // lowercase alphanumeric token). Require >=12 trailing chars so we match real
  // ids while excluding the JSON key name `file_id` (only 2 chars after prefix).
  const matches = scan.match(/file_[0-9a-zA-Z]{12,}/g);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

function toolResultMatchesUse(resultEvent: ForwardEvent, useEvent: ForwardEvent) {
  if (eventViewKind(resultEvent) !== 'tool_result') return false;
  if (resultEvent.session_id !== useEvent.session_id) return false;

  const resultId = toolEventId(resultEvent);
  const useId = toolEventId(useEvent) || useEvent.id;
  if (resultId && useId && resultId === useId) return true;

  return Boolean(
    resultEvent.turn_id &&
    useEvent.turn_id &&
    resultEvent.turn_id === useEvent.turn_id &&
    toolEventName(resultEvent) === toolEventName(useEvent),
  );
}

function isSameTurnOrUnknown(event: ForwardEvent, target: ForwardEvent) {
  return (
    event.session_id === target.session_id &&
    (!event.turn_id || !target.turn_id || event.turn_id === target.turn_id)
  );
}

function isTerminalEvent(event: ForwardEvent) {
  return (
    event.type === 'agent.message' ||
    event.type === 'session.status_idle' ||
    event.type === 'session.error' ||
    event.type === 'session.completed' ||
    event.type === 'session.cancelled' ||
    event.type === 'session.canceled'
  );
}

function isToolUsePending(events: ForwardEvent[], event: ForwardEvent, index: number) {
  for (const item of events.slice(index + 1)) {
    if (!isSameTurnOrUnknown(item, event)) continue;
    if (toolResultMatchesUse(item, event)) return false;
    if (
      eventViewKind(item) === 'tool_result' &&
      (!toolEventId(item) || toolEventName(item) === 'tool')
    ) {
      return false;
    }
    if (isTerminalEvent(item)) return false;
    if (eventViewKind(item) === 'user') return false;
  }
  return true;
}

function toolDisplayNameForEvent(events: ForwardEvent[], event: ForwardEvent, index: number) {
  const ownName = toolEventName(event);
  if (eventViewKind(event) !== 'tool_result' || ownName !== 'tool') return ownName;

  for (let i = index - 1; i >= 0; i -= 1) {
    const item = events[i];
    if (!isSameTurnOrUnknown(item, event)) continue;
    if (eventViewKind(item) !== 'tool_use') continue;
    if (toolResultMatchesUse(event, item) || !toolEventId(event)) return toolEventName(item);
  }
  return ownName;
}

function eventDisplay(event: ForwardEvent) {
  const role = roleForEvent(event.type);
  const text = eventContentText(event);
  const status = typeof event.status === 'string' ? event.status : undefined;
  const reason = typeof event.reason === 'string' ? event.reason : undefined;
  const error = event.error;
  let message = text;

  if (!message) {
    if (event.type === 'session.status_running') message = 'Session 正在运行中';
    else if (event.type === 'session.status_idle') message = 'Session 已完成，回到空闲';
    else if (event.type === 'session.error') message = 'Session 运行失败';
    else if (event.type === 'agent.thinking') message = 'Agent 正在思考';
    else if (event.type === 'agent.message') message = 'Agent 已回复';
    else if (event.type === 'session.created') message = 'Session 已创建';
    else if (event.type === 'session.updated') message = `Session ${statusText(status) || '已更新'}`;
    else if (status) message = `${role === 'agent' ? 'Agent' : 'Session'} ${statusText(status)}`;
    else if (reason) message = reason;
    else if (error) message = typeof error === 'string' ? error : '运行失败';
    else if (role === 'user') message = '用户消息';
    else if (role === 'agent') message = 'Agent 事件已更新';
    else message = 'Session 事件已更新';
  }

  return {
    role,
    message: normalizeEventMessage(message),
    time: displayTime(event.created_at || event.processed_at),
  };
}

function isLocalThinkingEvent(event: ForwardEvent) {
  return event.id.startsWith('local-') && event.type === 'agent.thinking';
}

function shouldClearLocalThinking(event: ForwardEvent) {
  if (event.id.startsWith('local-')) return false;
  if (event.type.startsWith('agent.')) return true;
  return isTerminalSessionEvent(event);
}

function isTerminalSessionEvent(event: ForwardEvent, hasMultiagentThreads = false) {
  if (
    event.type === 'session.error' ||
    event.type === 'session.completed' ||
    event.type === 'session.cancelled' ||
    event.type === 'session.canceled' ||
    event.type === 'session.status_terminated'
  ) return true;
  // session.status_idle with stop_reason "requires_action" means agent is waiting
  // for tool confirmation - don't treat as terminal
  if (event.type === 'session.status_idle') {
    const stopReason = (event as unknown as { stop_reason?: { type?: string } }).stop_reason;
    if (stopReason?.type === 'requires_action') return false;
    return true;
  }
  // thread_status_idle is a thread-level terminal event for non-multiagent sessions.
  // In multiagent mode, child threads going idle should NOT terminate the stream —
  // only session.status_idle signals session-level completion. The coordinator is
  // still processing the child's result and will emit its own events afterwards.
  if (event.type === 'session.thread_status_idle') return !hasMultiagentThreads;
  return false;
}

function lastRemoteEventId(events: ForwardEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const id = events[index]?.id;
    if (id && !id.startsWith('local-')) return id;
  }
  return '';
}

function shouldClearLocalThinkingForEvent(event: ForwardEvent, localEvent: ForwardEvent) {
  if (!shouldClearLocalThinking(event)) return false;
  if (
    localEvent.turn_id &&
    event.turn_id &&
    localEvent.turn_id !== event.turn_id
  ) {
    return false;
  }
  return true;
}

function eventSortKey(event: ForwardEvent): string {
  return event.processed_at || event.created_at || '';
}

function sortEventsForView(events: ForwardEvent[]): ForwardEvent[] {
  // Merge paths append incoming events, so a late poll can deliver an older
  // turn's canonical events AFTER a newer local message was pushed — which used
  // to render the new question above the previous turn. Order remote events by
  // server timestamps (stable sort keeps ties in arrival order), and keep local
  // placeholders (in-flight user message / thinking bubble / streaming text)
  // pinned to the tail: they always belong to the newest turn, and client/server
  // clock skew makes their created_at incomparable with server timestamps.
  // Remote events that don't carry a server timestamp yet (e.g. straight from
  // the POST /events response) are also pinned until a poll backfills it.
  const remote = events.filter((event) => !event.id.startsWith('local-') && eventSortKey(event));
  const local = events.filter((event) => event.id.startsWith('local-') || !eventSortKey(event));
  remote.sort((a, b) => {
    const ka = eventSortKey(a);
    const kb = eventSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return [...remote, ...local];
}

/**
 * Compute text similarity using character bigrams (Jaccard index).
 * Works for both Chinese and English text without needing word segmentation.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
function textSimilarity(a: string, b: string): number {
  if (a.length < 20 || b.length < 20) return 0;
  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i += 1) bigramsA.add(a.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i += 1) bigramsB.add(b.slice(i, i + 2));
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection += 1;
  }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * If the last real agent.message in the events list has >60% text similarity
 * to the incoming event, remove it. The coordinator sometimes outputs the
 * same report twice (first a draft, then a "verified" version) — showing both
 * is redundant and confuses users.
 */
function deduplicateAgentMessage(events: ForwardEvent[], sessionId: string, newEvent: ForwardEvent): ForwardEvent[] {
  const newText = eventContentText(newEvent);
  if (newText.length < 50) return events;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === 'agent.message' && e.session_id === sessionId && !e.id.startsWith('local-stream-')) {
      const prevText = eventContentText(e);
      if (prevText.length >= 50 && textSimilarity(newText, prevText) > 0.6) {
        return events.filter((_, idx) => idx !== i);
      }
      break; // Only check the last agent.message
    }
  }
  return events;
}

/**
 * Scan a merged events list and remove earlier agent.message events that
 * are >60% similar to a later agent.message in the same session. Used by
 * mergeSessionEvents to deduplicate after fetching from the API.
 */
function deduplicateAgentMessageList(events: ForwardEvent[]): ForwardEvent[] {
  const result: ForwardEvent[] = [];
  for (const event of events) {
    if (
      event.type === 'agent.message' &&
      !event.id.startsWith('local-stream-') &&
      eventContentText(event).length >= 50
    ) {
      // Check if the last agent.message in result is similar
      for (let i = result.length - 1; i >= 0; i -= 1) {
        const prev = result[i];
        if (
          prev.type === 'agent.message' &&
          !prev.id.startsWith('local-stream-') &&
          prev.session_id === event.session_id
        ) {
          const prevText = eventContentText(prev);
          const newText = eventContentText(event);
          if (prevText.length >= 50 && textSimilarity(newText, prevText) > 0.6) {
            result.splice(i, 1); // Remove the previous duplicate
          }
          break; // Only check the last agent.message
        }
      }
    }
    result.push(event);
  }
  return result;
}

function mergeIncomingEvents(prev: ForwardEvent[], incoming: ForwardEvent[]) {
  let next = [...prev];
  for (const event of incoming) {
    const existingIndex = next.findIndex((item) => item.id === event.id);
    if (existingIndex >= 0) {
      // Already known: only backfill the server timestamp (needed for ordering)
      // without replacing the stored event — it may carry injected content
      // (e.g. accumulated thinking text) that the polled copy lacks.
      const existing = next[existingIndex];
      if (!existing.processed_at && event.processed_at) {
        next[existingIndex] = { ...existing, processed_at: event.processed_at };
      }
      continue;
    }
    if (event.type === 'user.message') {
      const incomingText = eventContentText(event);
      const localIndex = next.findIndex((item) => (
        item.id.startsWith('local-') &&
        item.type === 'user.message' &&
        item.session_id === event.session_id &&
        eventContentText(item) === incomingText
      ));
      if (localIndex >= 0) {
        next[localIndex] = event;
        const thinkingIndex = next.findIndex((item, index) => (
          index > localIndex &&
          isLocalThinkingEvent(item) &&
          item.session_id === event.session_id
        ));
        if (thinkingIndex >= 0 && event.turn_id) {
          next[thinkingIndex] = { ...next[thinkingIndex], turn_id: event.turn_id };
        }
        continue;
      }
    }
    // When a remote agent.thinking event arrives with no content, check if there
    // is a local thinking event that already has accumulated thinking text.
    // If so, transfer the content to the remote event instead of losing it.
    if (event.type === 'agent.thinking' && !eventThinkingText(event)) {
      const localIdx = next.findIndex((item) => (
        isLocalThinkingEvent(item) &&
        item.session_id === event.session_id &&
        eventThinkingText(item)
      ));
      if (localIdx >= 0) {
        next[localIdx] = { ...event, content: next[localIdx].content };
        continue;
      }
    }
    if (shouldClearLocalThinking(event)) {
      next = next.filter((item) => !(
        isLocalThinkingEvent(item) &&
        item.session_id === event.session_id &&
        shouldClearLocalThinkingForEvent(event, item)
      ));
    }
    next = [...next, event];
  }
  return sortEventsForView(next);
}

function localTurnEvents(sessionId: string, text: string) {
  const now = new Date().toISOString();
  const turnId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    user: {
      id: `${turnId}-user`,
      type: 'user.message',
      session_id: sessionId,
      created_at: now,
      content: [{ type: 'text', text }],
    } satisfies ForwardEvent,
    thinking: {
      id: `${turnId}-thinking`,
      type: 'agent.thinking',
      session_id: sessionId,
      created_at: now,
      status: 'thinking',
      reason: 'AI 正在思考',
    } satisfies ForwardEvent,
  };
}

// ─── Chat attachments ─────────────────────────────────────────────
// Files API only accepts text-like files (see Files API docs), and the live
// Forward API rejects event.file_attachments, so attachments are delivered by
// mounting the uploaded file into the agent workspace and appending a marker
// block to the user message text. The bubble parses the marker back into
// chips, which also keeps attachments visible after history reloads.
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_EXTENSIONS = [
  'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'log',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'go', 'rs', 'java', 'kt', 'scala', 'c', 'cpp', 'cc', 'h', 'hpp', 'rb', 'php',
  'swift', 'r', 'lua', 'pl', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql',
  'proto', 'dockerfile', 'makefile', 'gitignore', 'editorconfig', 'eslintrc', 'prettierrc',
  'tex', 'rst', 'adoc', 'org', 'svg',
];
const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`).join(',');

interface PendingAttachment {
  localId: string;
  file: File;
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  fileId?: string;
  storedName?: string;
  error?: string;
}

function attachmentMountPath(storedName: string): string {
  return `/data/workspace/${storedName}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

// Marker block appended to the user message text: the agent learns where the
// files are, and the UI parses it back into chips after history reloads (the
// server stores message text verbatim).
function composeMessageWithAttachments(text: string, storedNames: string[]): string {
  if (storedNames.length === 0) return text;
  const markers = storedNames.map((name) => `[附件] ${name} → ${attachmentMountPath(name)}`);
  return `${text}\n\n${markers.join('\n')}`;
}

const ATTACHMENT_MARKER_RE = /^\[附件\] (.+?) → (\/\S+)$/;

function splitAttachmentMarkers(text: string): { body: string; attachments: Array<{ name: string; path: string }> } {
  const lines = text.split('\n');
  const attachments: Array<{ name: string; path: string }> = [];
  let i = lines.length - 1;
  while (i >= 0) {
    const match = ATTACHMENT_MARKER_RE.exec(lines[i]);
    if (!match) break;
    attachments.unshift({ name: match[1], path: match[2] });
    i -= 1;
  }
  if (attachments.length === 0) return { body: text, attachments: [] };
  const body = lines.slice(0, i + 1).join('\n').replace(/\s+$/, '');
  return { body, attachments };
}

function groupSessionsByDate(sessions: ForwardSession[]): Array<{ label: string; items: ForwardSession[] }> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const groups: Record<string, ForwardSession[]> = { today: [], yesterday: [], week: [], earlier: [] };
  for (const session of sessions) {
    const date = new Date(session.created_at);
    if (Number.isNaN(date.getTime())) {
      groups.earlier.push(session);
      continue;
    }
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (dayStart.getTime() >= today.getTime()) groups.today.push(session);
    else if (dayStart.getTime() >= yesterday.getTime()) groups.yesterday.push(session);
    else if (dayStart.getTime() >= weekAgo.getTime()) groups.week.push(session);
    else groups.earlier.push(session);
  }

  const labels: Record<string, string> = { today: '今天', yesterday: '昨天', week: '最近 7 天', earlier: '更早' };
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => ({ label: labels[key], items }));
}

function relativeTime(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function BrandIcon({ className = 'h-7 w-7', rounded = 'rounded-lg' }: { className?: string; rounded?: string }) {
  return (
    <img
      src={FORWARD_ICON}
      alt={PRODUCT_NAME}
      className={`${className} ${rounded} object-contain`}
      draggable={false}
    />
  );
}

function ChatAvatar({ user }: { user?: boolean }) {
  void user;
  return null;
}

const ThinkingMessage = memo(function ThinkingMessage({ event }: { event: ForwardEvent }) {
  const text = truncateForDisplay(eventThinkingText(event));
  const payload = truncateForDisplay(stringifyPayload(eventDebugPayload(event)));
  const isLocalWaiting = event.id.startsWith('local-');

  if (isLocalWaiting) {
    return (
      <div className="flex gap-4">
        <ChatAvatar />
        <div className="rounded-[18px] bg-white px-6 py-5 shadow-[0_8px_24px_rgba(47,58,128,0.05)]">
          <div className="h-2 w-[260px] max-w-[48vw] overflow-hidden rounded-full bg-[#EDEEF6]">
            <div className="h-full w-full rounded-full bg-[linear-gradient(90deg,#59A9F7_0%,#3550FF_50%,#7A5FF5_100%)] animate-loading-bar" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-4">
      <ChatAvatar />
      <div className="w-fit max-w-[92%]">
        <details className="group" open={!!(text || payload)}>
          <summary className="flex w-fit cursor-pointer list-none items-center gap-2.5 rounded-[16px] bg-white px-3.5 py-2.5 text-[13px] text-black/55 shadow-[0_8px_24px_rgba(47,58,128,0.05)]">
            <span className="text-black/35">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 18h6m-5 3h4m-8-9a6 6 0 1 1 12 0c0 2.1-1.1 3.1-2.2 4.1-.8.7-1.3 1.4-1.3 2.4h-5c0-1-.5-1.7-1.3-2.4C7.1 15.1 6 14.1 6 12Z" />
              </svg>
            </span>
            <span className="text-[13px] font-semibold italic text-black/38">Agent思考</span>
            <span className="text-black/35 group-open:hidden">›</span>
            <span className="hidden text-black/35 group-open:inline">⌄</span>
          </summary>
          <div className="mt-3 rounded-[18px] bg-white px-5 py-5 shadow-[0_8px_24px_rgba(47,58,128,0.05)]">
            <div className="rounded-xl border border-amber-200 bg-[#FFFCF2] px-4 py-3 text-[13px] leading-5 text-[#4B5563]">
              {(text || payload)
                ? <div className="markdown-body whitespace-pre-wrap break-words">{text || payload}</div>
                : <div className="italic text-black/40">Agent 在此进行了思考。API 不对外公开思考的具体内容，此事件仅作为思考过程的标记。</div>}
            </div>
          </div>
        </details>
        {event.created_at && <div className="mt-1 px-1 text-[11px] text-black/30">{displayTime(event.created_at)}</div>}
      </div>
    </div>
  );
});

function ArtifactDownloadCard({ ctx, fileId }: { ctx: ForwardContext | null; fileId: string }) {
  const [meta, setMeta] = useState<CloudFile | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void getCloudFile(ctx, fileId)
      .then((file) => {
        if (cancelled) return;
        setMeta(file);
        // 图片类型：通过服务端代理预览（绕过 OSS CORS 和 attachment 头）
        // dev 模式下直接请求 Express 端口（3001）避免 Vite proxy 覆盖 Content-Type；
        // 生产环境同源，用相对路径即可。
        if (isImageFile(file)) {
          const base = import.meta.env.DEV ? 'http://localhost:3001' : '';
          const previewUrl = `${base}/api/cloud/files/${encodeURIComponent(fileId)}/preview?pat=${encodeURIComponent(ctx.pat)}&environment=${encodeURIComponent(ctx.environment)}`;
          if (!cancelled) setImageUrl(previewUrl);
        }
      })
      .catch(() => { /* filename is best-effort; keep showing the id */ });
    return () => { cancelled = true; };
  }, [ctx, fileId]);

  const filename = meta?.filename || fileId;

  const handleDownload = async () => {
    if (!ctx || loading) return;
    setError('');
    setLoading(true);
    try {
      // Per Cloud API: GET /files/{id}/content returns a JSON body with a
      // time-limited pre-signed `url`. We then navigate to that URL to download.
      const { url } = await downloadCloudFile(ctx, fileId);
      if (!url) throw new Error('未获取到下载链接');
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // 图片类型：内联预览 + 下载按钮
  if (imageUrl) {
    return (
      <div className="flex w-full max-w-[420px] flex-col gap-2">
        <ChatImage src={imageUrl} alt={filename} showDownload={false} />
        <button
          type="button"
          onClick={handleDownload}
          disabled={loading}
          title={`下载 ${filename}`}
          className="group flex items-center gap-2 self-start rounded-lg border border-[#DDE2F2] bg-white px-3 py-1.5 text-[12px] text-black/60 transition hover:border-[#3550FF] hover:text-[#3550FF] disabled:opacity-60"
        >
          {loading ? (
            <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#D7DBEA] border-t-[#3550FF]" />
          ) : (
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          )}
          下载原图
          {meta?.size_bytes != null ? ` · ${formatFileSize(meta.size_bytes)}` : ''}
        </button>
        {error && <span className="text-[11px] text-red-500">{error}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={!ctx || loading}
      title={`下载 ${filename}`}
      className="group flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-[#DDE2F2] bg-white px-3.5 py-3 text-left transition hover:border-[#3550FF] hover:shadow-[0_6px_18px_rgba(53,80,255,0.10)] disabled:opacity-60"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EEF1FF] text-[#3550FF]">
        <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-black/80">{filename}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-black/35">
          {meta?.size_bytes != null ? `${formatFileSize(meta.size_bytes)} · ` : ''}{fileId}
        </span>
        {error && <span className="mt-0.5 block truncate text-[11px] text-red-500">{error}</span>}
      </span>
      <span className="shrink-0 text-black/30 transition group-hover:text-[#3550FF]">
        {loading ? (
          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-[#D7DBEA] border-t-[#3550FF]" />
        ) : (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        )}
      </span>
    </button>
  );
}

const ToolEventMessage = memo(function ToolEventMessage({
  event,
  result,
  pending = false,
  displayName,
  ctx,
}: {
  event: ForwardEvent;
  result: boolean;
  pending?: boolean;
  displayName?: string;
  ctx?: ForwardContext | null;
}) {
  const name = displayName || toolEventName(event);
  const payload = toolEventPayload(event);
  const id = toolEventId(event);
  const artifactIds = result && name === 'DeliverArtifacts' ? extractArtifactFileIds(event) : [];
  const tone = result
    ? 'bg-emerald-50 text-emerald-700'
    : 'bg-orange-50 text-orange-600';

  return (
    <div className="flex gap-4">
      <ChatAvatar />
      <div className="w-fit max-w-[92%]">
        <details className="group w-fit max-w-full rounded-[16px] bg-white px-3.5 py-2.5 shadow-[0_8px_24px_rgba(47,58,128,0.05)] open:w-[min(720px,calc(100vw-220px))]">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[13px]">
            <span className="text-black/45">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-5.9 5.9a2.1 2.1 0 1 1-3-3l5.9-5.9a5 5 0 0 1 6.4-6.4l-3 3 3 3Z" />
              </svg>
            </span>
            <span className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${tone}`}>
              {result ? '结果' : '调用'}
            </span>
            <span className="min-w-0 truncate font-mono text-xs text-black/55" title={name}>
              {name}
            </span>
            {pending && !result ? (
              <span className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[#D7DBEA] border-t-[#7A5FF5] group-open:hidden" aria-label="工具执行中" />
            ) : (
              <span className="ml-auto text-black/30 group-open:hidden">›</span>
            )}
            <span className="ml-auto hidden text-black/30 group-open:inline">⌄</span>
          </summary>
          <div className="mt-3">
            <div className="mb-2 text-[13px] font-semibold text-black/35">
              {result ? '出参' : '入参'}
            </div>
            {id && <div className="mb-2 truncate font-mono text-[11px] text-black/35">ID: {id}</div>}
            {payload ? (
              <pre
                className={`max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl border p-3.5 font-mono text-[13px] leading-5 ${
                  result
                    ? 'border-emerald-200 bg-emerald-50 text-[#111827]'
                    : 'border-[#DADCE3] bg-[#FAFAFA] text-[#111827]'
                }`}
              >
                {payload}
              </pre>
            ) : (
              <div className="text-xs text-black/35">暂无详情</div>
            )}
          </div>
        </details>
        {artifactIds.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {artifactIds.map((fileId) => (
              <ArtifactDownloadCard key={fileId} ctx={ctx ?? null} fileId={fileId} />
            ))}
          </div>
        )}
        {event.created_at && <div className="mt-1 px-1 text-[11px] text-black/30">{displayTime(event.created_at)}</div>}
      </div>
    </div>
  );
});

// Track user message timestamps for response time calculation
const _turnTimestamps = new Map<string, number>();

function recordTurnStart(sessionId: string) {
  _turnTimestamps.set(sessionId, Date.now());
}

function getResponseTime(event: ForwardEvent): string | null {
  // Only show response time on the FINAL agent.message, not on synthetic
  // streaming messages (which have local-stream- prefix IDs)
  if (event.id.startsWith('local-stream-')) return null;
  const ts = _turnTimestamps.get(event.session_id);
  if (!ts) return null;
  // Use processed_at if available, otherwise use current time
  const agentTime = event.processed_at ? new Date(event.processed_at).getTime() : Date.now();
  if (Number.isNaN(agentTime)) return null;
  const ms = agentTime - ts;
  if (ms < 0 || ms > 300000) return null; // sanity: 0-5min
  _turnTimestamps.delete(event.session_id); // consume once
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}


function sessionErrorDetail(event: ForwardEvent): string {
  const err = event.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const rec = err as { message?: string; type?: string };
    return rec.message || rec.type || '';
  }
  return '';
}

const SessionErrorMessage = memo(function SessionErrorMessage({ event }: { event: ForwardEvent }) {
  const detail = sessionErrorDetail(event);
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] leading-6 text-red-600">
        <span className="font-medium">本轮回复失败</span>
        {detail && <span className="ml-1 text-red-500/80">（{detail}）</span>}
        <span className="ml-1">请稍后重新发送。</span>
      </div>
    </div>
  );
});

// Chips above the composer textarea for picked attachments, ChatGPT-style:
// spinner while uploading, error state with retry, and a remove button.
const AttachmentChips = memo(function AttachmentChips({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: PendingAttachment[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <span
          key={a.localId}
          title={a.status === 'error' ? (a.error || '上传失败') : a.name}
          className={`inline-flex max-w-[240px] items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] leading-4 ${
            a.status === 'error'
              ? 'border-red-200 bg-red-50 text-red-600'
              : 'border-black/10 bg-[#F7F8FC] text-black/70'
          }`}
        >
          {a.status === 'uploading' ? (
            <svg className="h-3 w-3 shrink-0 animate-spin text-[#3550FF]" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2Z" />
            </svg>
          ) : (
            <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
          )}
          <span className="truncate">{a.name}</span>
          <span className={`shrink-0 ${a.status === 'error' ? 'text-red-400' : 'text-black/30'}`}>
            {a.status === 'error' ? '上传失败' : formatBytes(a.size)}
          </span>
          {a.status === 'error' && (
            <button type="button" onClick={() => onRetry(a.localId)} className="shrink-0 font-medium text-[#3550FF] hover:underline">重试</button>
          )}
          <button type="button" onClick={() => onRemove(a.localId)} className="shrink-0 text-black/30 hover:text-black/60" title="移除附件">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </span>
      ))}
    </div>
  );
});

// Gear button next to the send button that opens a small popover holding the
// "show thinking / show tool calls" switches, replacing the old inline toggles.
const ChatSettingsButton = memo(function ChatSettingsButton({
  showThinking,
  showToolCalls,
  onToggleThinking,
  onToggleToolCalls,
}: {
  showThinking: boolean;
  showToolCalls: boolean;
  onToggleThinking: () => void;
  onToggleToolCalls: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        title="回复显示设置"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
          open ? 'bg-[#EEF1FF] text-[#3550FF]' : 'text-black/35 hover:bg-black/5 hover:text-black/60'
        }`}
      >
        <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a7.723 7.723 0 0 1 0-.255c.007-.378-.138-.75-.43-.991l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-20 mb-2 w-60 rounded-xl border border-black/8 bg-white p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-black/35">回复显示设置</div>
            {[
              { label: '显示思考过程', checked: showThinking, onToggle: onToggleThinking },
              { label: '显示工具调用', checked: showToolCalls, onToggle: onToggleToolCalls },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.onToggle}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition hover:bg-black/[0.03]"
              >
                <span className="text-[13px] text-black/70">{item.label}</span>
                <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${item.checked ? 'bg-[#3550FF]' : 'bg-gray-200'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${item.checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
});

const ChatTextMessage = memo(function ChatTextMessage({ event, user }: { event: ForwardEvent; user?: boolean }) {
  const item = eventDisplay(event);

  if (user) {
    const { body, attachments: msgAttachments } = splitAttachmentMarkers(item.message);
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] rounded-2xl bg-[#EBF0FF] px-4 py-2.5 text-[14px] leading-6 text-black">
          {msgAttachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {msgAttachments.map((a) => (
                <span key={a.path} title={a.path} className="inline-flex max-w-[220px] items-center gap-1 rounded-lg bg-white/80 px-2 py-0.5 text-[12px] leading-4 text-black/60">
                  <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32a1.5 1.5 0 0 1-2.122-2.122l7.693-7.693" />
                  </svg>
                  <span className="truncate">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words">{body}</div>
        </div>
      </div>
    );
  }

  const responseTime = getResponseTime(event);
  // Render markdown live during streaming too. Real-time cost stays bounded by the
  // throttled flush (<=10fps), React.memo (only this message re-renders per flush),
  // and truncateForDisplay (caps huge synchronous renders that could freeze the tab).

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] text-[14px] leading-7 text-[#1a1a1a]">
        <div className="markdown-body break-words">{renderMarkdown(truncateForDisplay(item.message))}</div>
        {responseTime && (
          <div className="mt-1.5 text-[11px] text-black/25">
            ⏱ {responseTime}
          </div>
        )}
      </div>
    </div>
  );
});

function NavIcon({ panel }: { panel: SidebarPanel }) {
  const c = 'h-4 w-4 shrink-0';
  if (panel === 'chat') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" /></svg>);
  if (panel === 'schedules') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>);
  if (panel === 'channels') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>);
  if (panel === 'templates') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" /></svg>);
  if (panel === 'skills') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" /></svg>);
  if (panel === 'files') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>);
  if (panel === 'environments') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0h.375a2.625 2.625 0 0 1 0 5.25H17.25m-13.5 0V15" /></svg>);
  if (panel === 'vaults') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" /></svg>);
  if (panel === 'memoryStores') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" /></svg>);
  if (panel === 'usage') return (<svg className={c} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" /></svg>);
  return null;
}

function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-[520px] max-h-[90vh] overflow-y-auto rounded-2xl bg-white px-5 py-4 shadow-[0_8px_40px_rgba(0,0,0,0.12)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-black">{title}</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-black/30 transition hover:bg-black/5 hover:text-black/60">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ResourceTokenSelect({
  label,
  placeholder,
  emptyText,
  resources,
  selectedIds,
  onAdd,
  onRemove,
  onRefresh,
}: {
  label: string;
  placeholder: string;
  emptyText: string;
  resources: ForwardResource[];
  selectedIds: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const availableResources = resources.filter((resource) => !selectedIds.includes(resource.id));

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative block" ref={ref}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-black/45">{label}</span>
        <button type="button" onClick={onRefresh} className="text-xs font-medium text-[#3550FF] transition hover:text-[#2a42e0]">
          刷新
        </button>
      </div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex h-10 w-full items-center justify-between gap-2 rounded-xl border bg-[#FBFCFF] px-3 text-left text-xs transition ${
          open ? 'border-[#3550FF] shadow-[0_0_0_3px_rgba(53,80,255,0.08)]' : 'border-[#2F3A8026] hover:border-[#B8C3FF]'
        }`}
      >
        <span className={availableResources.length > 0 ? 'text-black/70' : 'text-black/35'}>
          {selectedIds.length > 0 ? `已选择 ${selectedIds.length} 个` : availableResources.length > 0 ? placeholder : emptyText}
        </span>
        <svg className={`h-4 w-4 shrink-0 text-black/35 transition ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m7 10 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[66px] z-50 overflow-hidden rounded-2xl border border-[#DDE2F2] bg-white p-1 shadow-[0_12px_30px_rgba(47,58,128,0.14)]">
          <div className="max-h-56 overflow-y-auto py-1">
            {availableResources.length === 0 ? (
              <div className="px-3 py-3 text-xs text-black/35">{emptyText}</div>
            ) : (
              availableResources.map((resource) => (
                <button
                  key={resource.id}
                  type="button"
                  onClick={() => {
                    onAdd(resource.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-[#F4F6FC]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-black/75">{resourceDisplayName(resource)}</span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-black/35">{resource.id}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-[#EDEEF6] px-2 py-0.5 text-[10px] text-black/45">{resource.status || '已注册'}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
      {selectedIds.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {selectedIds.map((id) => (
            <span key={id} className="flex max-w-full items-center gap-1.5 rounded-full bg-[#EDEEF6] px-2.5 py-1 text-xs text-black/65">
              <span className="max-w-[320px] truncate">{resolveResourceName(resources, id)}</span>
              <span className="font-mono text-[10px] text-black/30">{id.length > 16 ? `${id.slice(0, 8)}…` : id}</span>
              <button type="button" onClick={() => onRemove(id)} className="text-black/35 transition hover:text-black" aria-label={`移除 ${id}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceSingleSelect({
  label,
  placeholder,
  emptyText,
  resources,
  selectedId,
  onChange,
  onRefresh,
}: {
  label: string;
  placeholder: string;
  emptyText: string;
  resources: ForwardResource[];
  selectedId: string;
  onChange: (id: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selectedResource = resources.find((resource) => resource.id === selectedId);
  const hasUnlistedSelection = Boolean(selectedId && !selectedResource);
  const displayValue = selectedResource ? resourceDisplayName(selectedResource) : selectedId;

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative block" ref={ref}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-black/45">{label}</span>
        <button type="button" onClick={onRefresh} className="text-xs font-medium text-[#3550FF] transition hover:text-[#2a42e0]">
          刷新
        </button>
      </div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex h-10 w-full items-center justify-between gap-2 rounded-xl border bg-[#FBFCFF] px-3 text-left text-sm transition ${
          open ? 'border-[#3550FF] shadow-[0_0_0_3px_rgba(53,80,255,0.08)]' : 'border-[#2F3A8026] hover:border-[#B8C3FF]'
        }`}
      >
        <span className={displayValue ? 'min-w-0 truncate text-black/75' : 'text-black/35'}>
          {displayValue || placeholder}
        </span>
        <svg className={`h-4 w-4 shrink-0 text-black/35 transition ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m7 10 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[66px] z-50 overflow-hidden rounded-2xl border border-[#DDE2F2] bg-white p-1 shadow-[0_12px_30px_rgba(47,58,128,0.14)]">
          <div className="max-h-56 overflow-y-auto py-1">
            {hasUnlistedSelection && (
              <button
                type="button"
                onClick={() => {
                  onChange(selectedId);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-xl bg-[#F8F9FF] px-3 py-2 text-left"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-black/75">{selectedId}</span>
                  <span className="mt-0.5 block text-[11px] text-black/35">当前填写，未在列表中</span>
                </span>
                <span className="h-2 w-2 shrink-0 rounded-full bg-[#3550FF]" />
              </button>
            )}
            {resources.length === 0 && !hasUnlistedSelection ? (
              <div className="px-3 py-3 text-xs text-black/35">{emptyText}</div>
            ) : (
              resources.map((resource) => {
                const selected = resource.id === selectedId;
                return (
                  <button
                    key={resource.id}
                    type="button"
                    onClick={() => {
                      onChange(resource.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition ${
                      selected ? 'bg-[#F4F6FC]' : 'hover:bg-[#F4F6FC]'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-black/75">{resourceDisplayName(resource)}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-black/35">{resource.id}</span>
                    </span>
                    {selected ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-[#3550FF]" />
                    ) : (
                      <span className="shrink-0 rounded-full bg-[#EDEEF6] px-2 py-0.5 text-[10px] text-black/45">{resource.status || '已注册'}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ApiEnvironmentSelect({
  value,
  onChange,
}: {
  value: ForwardApiEnvironment;
  onChange: (value: ForwardApiEnvironment) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = API_ENV_OPTIONS.find((option) => option.value === value) ?? API_ENV_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-[54px] w-full items-center border-b border-[#D5D8E6] text-left transition hover:border-[#B8C3FF] focus:outline-none"
      >
        <div className={`h-[22px] w-0.5 shrink-0 ${open ? 'bg-[#3550FF]' : 'bg-[#D5D8E6]'}`} />
        <span className="ml-2 flex-1 text-sm text-black">{selected.label}</span>
        <svg className={`h-4 w-4 shrink-0 text-black/35 transition ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m7 10 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[62px] z-50 overflow-hidden rounded-2xl border border-[#DDE2F2] bg-white p-1 shadow-[0_12px_30px_rgba(47,58,128,0.14)]">
          <div className="py-1">
            {API_ENV_OPTIONS.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition ${
                    isSelected ? 'bg-[#F4F6FC] text-[#3550FF]' : 'text-black/75 hover:bg-[#F4F6FC]'
                  }`}
                >
                  <span>{option.label}</span>
                  {isSelected && <span className="h-2 w-2 rounded-full bg-[#3550FF]" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [savedAuth] = useState(readSavedAuth);
  const [activePanel, setActivePanel] = useState<SidebarPanel>('chat');
  const [apiEnvironment, setApiEnvironment] = useState<ForwardApiEnvironment>(savedAuth.apiEnvironment);
  const [pat, setPat] = useState(savedAuth.pat);
  const [externalId, setExternalId] = useState(savedAuth.externalId);
  const [identity, setIdentity] = useState<ForwardIdentity | null>(null);
  const [templates, setTemplates] = useState<ForwardTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateModel, setTemplateModel] = useState('ultimate');
  const [templateSystem, setTemplateSystem] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [vaultIdsText, setVaultIdsText] = useState('');
  const [skillIdsText, setSkillIdsText] = useState('');
  const [fileIdsText, setFileIdsText] = useState('');
  const [envVarsText, setEnvVarsText] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([...BUILTIN_TOOLS]);
  const [toolsJson, setToolsJson] = useState('');
  const [mcpServersJson, setMcpServersJson] = useState('');
  // Multi-agent (coordinator) config in the template editor. The Forward API's
  // multiagent roster references Managed Agent IDs (agent_xxx), not template IDs
  // — Forward templates don't expose their backing agent_id, so the editor
  // lists managed agents by name and stores the agent ID. Toolset
  // (agent_toolset_20260401) is a hard prerequisite: the UI gates the section
  // until the user has picked at least one built-in tool.
  const [managedAgents, setManagedAgents] = useState<ManagedAgent[]>([]);
  const [managedAgentsLoading, setManagedAgentsLoading] = useState(false);
  const [multiagentEnabled, setMultiagentEnabled] = useState(false);
  const [multiagentSelectedAgentIds, setMultiagentSelectedAgentIds] = useState<string[]>([]);
  const [multiagentIncludeSelf, setMultiagentIncludeSelf] = useState(false);
  const [resourceType, setResourceType] = useState<ForwardResourceType>('skill');
  const [resourceId, setResourceId] = useState('');
  const [resources, setResources] = useState<ForwardResource[]>([]);
  const [resourceOptionsByType, setResourceOptionsByType] = useState<Record<ForwardResourceType, ForwardResource[]>>(emptyResourceOptions);
  const [sessions, setSessions] = useState<ForwardSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [events, setEvents] = useState<ForwardEvent[]>([]);
  const [input, setInput] = useState('');
  const [showThinking, setShowThinking] = useState<boolean>(() => {
    try { return localStorage.getItem('show_thinking') !== '0'; } catch { return true; }
  });
  const [showToolCalls, setShowToolCalls] = useState<boolean>(() => {
    try { return localStorage.getItem('show_tool_calls') !== '0'; } catch { return true; }
  });
  const toggleShowThinking = useCallback(() => {
    setShowThinking((prev) => {
      const v = !prev;
      try { localStorage.setItem('show_thinking', v ? '1' : '0'); } catch { /* ignore */ }
      return v;
    });
  }, []);
  const toggleShowToolCalls = useCallback(() => {
    setShowToolCalls((prev) => {
      const v = !prev;
      try { localStorage.setItem('show_tool_calls', v ? '1' : '0'); } catch { /* ignore */ }
      return v;
    });
  }, []);
  // True while a history session's events are being fetched after clicking it,
  // so the chat area can show a spinner instead of flashing the welcome screen.
  const [sessionLoading, setSessionLoading] = useState(false);
  // Pinned session ids (most recently pinned first), persisted locally — the
  // Forward API has no pin concept, so this is a pure client-side preference.
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('pinned_sessions') || '[]');
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  });
  const togglePinSession = useCallback((sessionId: string) => {
    setPinnedSessionIds((prev) => {
      const next = prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [sessionId, ...prev];
      try { localStorage.setItem('pinned_sessions', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showResourceModal, setShowResourceModal] = useState(false);
  const [showTemplateSwitcher, setShowTemplateSwitcher] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  // Developer mode unlocks template & template-resource management (create/edit/delete).
  // Default is user mode (false). Persisted so the choice survives reloads.
  const [developerMode, setDeveloperMode] = useState<boolean>(() => {
    try { return localStorage.getItem('developer_mode') === '1'; } catch { return false; }
  });
  const [showDevModeConfirm, setShowDevModeConfirm] = useState(false);
  const [viewingTemplate, setViewingTemplate] = useState<ForwardTemplate | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [viewingResource, setViewingResource] = useState<ForwardResource | null>(null);
  const [conversationSearch, setConversationSearch] = useState('');
  const [showCreateEnvModal, setShowCreateEnvModal] = useState(false);
  const [newEnvName, setNewEnvName] = useState('');
  const [newEnvDescription, setNewEnvDescription] = useState('');
  const [newEnvNetworking, setNewEnvNetworking] = useState<'unrestricted' | 'limited'>('limited');
  const [cloudModels, setCloudModels] = useState<CloudModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  // Resource create/delete state
  const [showCreateResourceModal, setShowCreateResourceModal] = useState(false);
  const [deleteConfirmResource, setDeleteConfirmResource] = useState<ForwardResource | null>(null);
  const [newResName, setNewResName] = useState('');
  const [newResDesc, setNewResDesc] = useState('');
  const [newResNetworking, setNewResNetworking] = useState<'unrestricted' | 'limited'>('limited');
  const [newResFile, setNewResFile] = useState<File | null>(null);
  const [editingResource, setEditingResource] = useState<ForwardResource | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editNetworking, setEditNetworking] = useState<'unrestricted' | 'limited'>('limited');
  const [vaultCredentials, setVaultCredentials] = useState<Array<{ id: string; auth: { type: string; mcp_server_url?: string; secret_name?: string } }>>([]);
  const [newCredType, setNewCredType] = useState<'static_bearer' | 'mcp_oauth' | 'environment_variable'>('static_bearer');
  const [newCredUrl, setNewCredUrl] = useState('');
  const [newCredToken, setNewCredToken] = useState('');
  const [newCredSecretName, setNewCredSecretName] = useState('');
  const [newCredSecretValue, setNewCredSecretValue] = useState('');
  const [newCredAccessToken, setNewCredAccessToken] = useState('');
  const [newCredExpiresAt, setNewCredExpiresAt] = useState('');
  const [schedules, setSchedules] = useState<ForwardSchedule[]>([]);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ForwardSchedule | null>(null);
  const [schedName, setSchedName] = useState('');
  const [schedDesc, setSchedDesc] = useState('');
  const [schedTemplateId, setSchedTemplateId] = useState('');
  const [schedTriggerType, setSchedTriggerType] = useState<'cron' | 'once' | 'interval' | 'manual'>('manual');
  const [schedExpression, setSchedExpression] = useState('');
  const [schedTimezone, setSchedTimezone] = useState('Asia/Shanghai');
  const [schedMessage, setSchedMessage] = useState('');
  const [runningScheduleId, setRunningScheduleId] = useState<string | null>(null);
  const [channels, setChannels] = useState<ForwardChannel[]>([]);
  const [memoryEntries, setMemoryEntries] = useState<Array<{ id: string; path: string; content?: string; size: number; version: number; updated_at?: string }>>([]);
  const [memoryTemplateId, setMemoryTemplateId] = useState('');
  const [memoryStoreId, setMemoryStoreId] = useState('');
  const [showChannelModal, setShowChannelModal] = useState(false);
  const [chanName, setChanName] = useState('');
  const [chanType, setChanType] = useState<ChannelType>('wechat');
  const [chanTemplateId, setChanTemplateId] = useState('');
  const [chanMode, setChanMode] = useState<'qr' | 'manual'>('qr');
  const [channelStep, setChannelStep] = useState<'config' | 'binding' | 'credentials'>('config');
  const [createdChannelId, setCreatedChannelId] = useState<string | null>(null);
  const [chanAppKey, setChanAppKey] = useState('');
  const [chanAppSecret, setChanAppSecret] = useState('');
  const [chanAgentId, setChanAgentId] = useState('');
  const [chanShowTools, setChanShowTools] = useState(false);
  const [chanShowThinking, setChanShowThinking] = useState(false);
  const [editingChannelItem, setEditingChannelItem] = useState<ForwardChannel | null>(null);
  const [deleteChannelId, setDeleteChannelId] = useState<string | null>(null);
  const [qrSession, setQrSession] = useState<ForwardQrSession | null>(null);
  const [qrPolling, setQrPolling] = useState(false);
  const [qrVerifying, setQrVerifying] = useState(false);
  const [qrBindingIssue, setQrBindingIssue] = useState('');
  const qrPollTimerRef = useRef<number | null>(null);
  const stopQrPolling = useCallback(() => {
    if (qrPollTimerRef.current !== null) {
      window.clearTimeout(qrPollTimerRef.current);
      qrPollTimerRef.current = null;
    }
    setQrPolling(false);
  }, []);
  const loadModels = useCallback(async (context: ForwardContext) => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const res = await listCloudModels(context);
      const models = res.data ?? [];
      setCloudModels(models);
      if (models.length > 0 && !models.find((m) => m.id === templateModel)) {
        setTemplateModel(models[0].id);
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setModelsLoading(false);
    }
  }, [templateModel]);

  // Load managed agents for the multiagent roster picker. Forward templates
  // don't expose their backing agent_id, so the editor lists agents by name
  // (each template compiles to a managed agent with a matching name).
  const loadManagedAgents = useCallback(async (context: ForwardContext) => {
    setManagedAgentsLoading(true);
    try {
      const res = await listManagedAgents(context);
      setManagedAgents(res.data ?? []);
    } catch {
      setManagedAgents([]);
    } finally {
      setManagedAgentsLoading(false);
    }
  }, []);

  const getModelLabel = useCallback((model: ForwardTemplate['model'] | unknown): string => {
    const modelId = getTemplateModelId(model);
    if (!modelId) return '未知模型';
    const fromApi = cloudModels.find((m) => m.id === modelId);
    if (fromApi) return fromApi.display_name;
    return MODEL_DISPLAY_NAMES[modelId] ?? modelId;
  }, [cloudModels]);
  const templateSwitcherRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  // Whether the chat should auto-stick to the bottom. Turns off when the user
  // scrolls up, so streaming updates during a running task won't yank them back.
  const stickToBottomRef = useRef(true);
  const startStreamRef = useRef<(sessionId: string, lastEventId?: string, turnStartedAt?: string, initialHasMultiagent?: boolean) => void>(() => {});
  const streamAbort = useRef<AbortController | null>(null);
  // Tracks sessions that have multiagent child threads (session.thread_created
  // seen at any point). Used to pass hasMultiagentThreads to startStream when a
  // follow-up message is sent, so session.thread_status_idle from a lingering
  // child doesn't prematurely terminate the new turn's stream.
  const multiagentSessionsRef = useRef<Set<string>>(new Set());
  // Tracks the session currently shown in the chat view ('' = new-conversation
  // screen), so background stream/poll callbacks never paint into another view.
  const currentSessionIdRef = useRef('');

  const ctx = useMemo<ForwardContext | null>(
    () => (pat.trim() ? { pat: pat.trim(), environment: apiEnvironment } : null),
    [apiEnvironment, pat],
  );

  // Attachments picked in the composer. They upload immediately on selection
  // (ChatGPT-style progress chips), then get mounted into the session
  // workspace when the message is sent.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const uploadAttachment = useCallback(async (localId: string, file: File) => {
    if (!ctx) return;
    try {
      const uploaded = await uploadCloudFile(ctx, { file, name: file.name, metadata: { source: 'chat-attachment' } });
      setAttachments((prev) => prev.map((a) => (
        a.localId === localId ? { ...a, status: 'done', fileId: uploaded.id, storedName: uploaded.filename } : a
      )));
    } catch (err) {
      setAttachments((prev) => prev.map((a) => (
        a.localId === localId ? { ...a, status: 'error', error: err instanceof Error ? err.message : String(err) } : a
      )));
    }
  }, [ctx]);

  const pickAttachments = useCallback((files: FileList | null) => {
    if (!files || files.length === 0 || !ctx) return;
    const accepted: PendingAttachment[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      const ext = (file.name.includes('.') ? file.name.split('.').pop()! : file.name).toLowerCase();
      if (!ATTACHMENT_EXTENSIONS.includes(ext)) { rejected.push(`「${file.name}」类型不支持`); continue; }
      if (file.size > ATTACHMENT_MAX_BYTES) { rejected.push(`「${file.name}」超过 5 MB 限制`); continue; }
      accepted.push({
        localId: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        name: file.name,
        size: file.size,
        status: 'uploading',
      });
    }
    if (rejected.length > 0) setError(`附件已跳过：${rejected.join('、')}（仅支持单个 ≤5MB 的文本类文件）`);
    else setError('');
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
      for (const a of accepted) void uploadAttachment(a.localId, a.file);
    }
  }, [ctx, uploadAttachment]);

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  }, []);

  const retryAttachment = useCallback((localId: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId);
      if (target && target.status === 'error') void uploadAttachment(localId, target.file);
      return prev.map((a) => (a.localId === localId && a.status === 'error' ? { ...a, status: 'uploading', error: undefined } : a));
    });
  }, [uploadAttachment]);

  useEffect(() => () => streamAbort.current?.abort(), []);

  // Track whether the user is pinned to the bottom of the chat. When they scroll
  // up during a running task, we stop auto-scrolling to preserve their position.
  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  }, []);

  // Auto-scroll to bottom on new events only when the user is already at the bottom.
  useEffect(() => {
    if (stickToBottomRef.current && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [events]);

  // Load vault credentials when viewing a vault
  useEffect(() => {
    if (viewingResource?.type === 'vault' && ctx) {
      setVaultCredentials([]);
      listCloudCredentials(ctx, viewingResource.id)
        .then((res) => setVaultCredentials(res.data || []))
        .catch(() => setVaultCredentials([]));
    }
  }, [viewingResource, ctx]);

  // Clean up QR polling on unmount
  useEffect(() => {
    return () => { stopQrPolling(); };
  }, [stopQrPolling]);

  useEffect(() => {
    if (!showTemplateSwitcher) return;
    const handler = (e: MouseEvent) => {
      if (templateSwitcherRef.current && !templateSwitcherRef.current.contains(e.target as Node)) {
        setShowTemplateSwitcher(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTemplateSwitcher]);

  useEffect(() => {
    if (!showUserMenu) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUserMenu]);

  // Save last used template to localStorage when templateId changes
  useEffect(() => {
    if (templateId && apiEnvironment && externalId) {
      const lastTemplateKey = `last_template_${apiEnvironment}_${externalId}`;
      localStorage.setItem(lastTemplateKey, templateId);
    }
  }, [templateId, apiEnvironment, externalId]);

  // Keep a ref in sync so that refreshSessions (called from background polling /
  // SSE closures) always reads the *current* templateId, not a stale value from
  // the closure when startStream was created.  Without this, switching templates
  // while a task is running causes the old closure to overwrite the session list
  // with the previous template's sessions.
  const templateIdRef = useRef(templateId);
  useEffect(() => { templateIdRef.current = templateId; }, [templateId]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const refreshSessions = useCallback(async (nextIdentity = identity, nextTemplateId?: string) => {
    if (!ctx || !nextIdentity) return;
    const tplId = nextTemplateId ?? templateIdRef.current;
    const page = await listSessions(ctx, nextIdentity.id, tplId || undefined);
    setSessions(page.data);
    // Never auto-select a session here: background polling calls this while the
    // user may be sitting on the new-conversation screen (currentSessionId === '').
  }, [ctx, identity]);

  const loadSessionEvents = useCallback(async (sessionId: string) => {
    if (!ctx || !sessionId) return;
    const page = await listEvents(ctx, sessionId);
    // Events are returned in descending order (newest first), reverse to chronological order
    setEvents([...page.data].reverse());
  }, [ctx]);

  const mergeSessionEvents = useCallback(async (sessionId: string) => {
    if (!ctx || !sessionId) return;
    const page = await listEvents(ctx, sessionId);
    // Reverse to chronological order before merging
    const chronologicalData = [...page.data].reverse();
    // Only merge into the view when this session is still the one on screen;
    // background polling must not repopulate the new-conversation screen.
    if (currentSessionIdRef.current === sessionId) {
      setEvents((prev) => {
        // If real agent.message events exist in the fetched data, remove any
        // leftover synthetic streaming messages (local-stream-*) from a
        // prematurely terminated stream.
        const hasRealMessage = chronologicalData.some(
          (e) => e.type === 'agent.message' && !e.id.startsWith('local-stream-'),
        );
        const filtered = hasRealMessage
          ? prev.filter((e) => !e.id.startsWith('local-stream-'))
          : prev;
        const merged = mergeIncomingEvents(filtered, chronologicalData);
        // Deduplicate similar consecutive agent.message events (the
        // coordinator sometimes outputs the same report twice).
        return deduplicateAgentMessageList(merged);
      });
    }
    return { ...page, data: chronologicalData };
  }, [ctx]);

  const loadResources = useCallback(async (nextType = resourceType, updateActiveList = true) => {
    if (!ctx) return;
    setError('');
    try {
      const page = await listResources(ctx, nextType);
      let data = page.data;
      // The Forward /resources endpoint may not echo a usable display name for skills,
      // causing the UI to fall back to the raw skill_ id. Enrich with the authoritative
      // name from the Cloud Skills API (best-effort) so the user-given name is shown.
      if (nextType === 'skill') {
        try {
          const cloud = await listCloudSkills(ctx);
          const nameMap = new Map(
            cloud.data.map((s) => [s.id, s.display_title || s.name]),
          );
          data = data.map((r) => {
            const cloudName = nameMap.get(r.id);
            return cloudName ? { ...r, name: r.name || cloudName } : r;
          });
        } catch {
          // Enrichment is best-effort; keep the raw Forward resource list on failure.
        }
      }
      setResourceOptionsByType((prev) => ({ ...prev, [nextType]: data }));
      if (updateActiveList || nextType === resourceType) setResources(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, resourceType]);

  // Load skill resources when viewing a template
  useEffect(() => {
    if (viewingTemplate && ctx && resourceOptionsByType.skill.length === 0) {
      void loadResources('skill', false);
    }
  }, [viewingTemplate, ctx, resourceOptionsByType.skill.length, loadResources]);

  const loadSchedules = useCallback(async () => {
    if (!ctx || !identity) return;
    try {
      const page = await listSchedules(ctx, identity.id);
      setSchedules(page.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, identity]);

  const handleCreateSchedule = useCallback(async () => {
    if (!ctx || !identity || !schedName.trim() || !schedTemplateId || !schedMessage.trim()) return;
    const tpl = templates.find((t) => t.id === schedTemplateId);
    if (!tpl) return;
    setLoading(true);
    setError('');
    try {
      const triggerPolicy = schedTriggerType === 'manual'
        ? { type: 'manual' as const }
        : { type: schedTriggerType, expression: schedExpression, ...((schedTriggerType === 'cron' || schedTriggerType === 'once') ? { timezone: schedTimezone } : {}) };
      const input: CreateScheduleInput = {
        name: schedName.trim(),
        description: schedDesc.trim() || undefined,
        identity_id: identity.id,
        template_id: schedTemplateId,
        environment_id: tpl.environment_id || '',
        initial_events: [{ type: 'user.message', content: schedMessage.trim() }],
        trigger_policy: triggerPolicy,
      };
      if (editingSchedule) {
        await updateSchedule(ctx, editingSchedule.id, input);
      } else {
        await createSchedule(ctx, input);
      }
      setShowScheduleModal(false);
      setEditingSchedule(null);
      setSchedName(''); setSchedDesc(''); setSchedMessage(''); setSchedExpression('');
      await loadSchedules();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, identity, schedName, schedDesc, schedTemplateId, schedTriggerType, schedExpression, schedTimezone, schedMessage, templates, editingSchedule, loadSchedules]);

  const handleRunSchedule = useCallback(async (schedule: ForwardSchedule) => {
    if (!ctx) return;
    setRunningScheduleId(schedule.id);
    setError('');
    try {
      const run = await runSchedule(ctx, schedule.id);
      // Poll the run until it has a session_id or reaches terminal state
      if (run.status === 'skipped') {
        setError(run.error_message || run.error?.type || '任务被跳过（可能已达并发上限）');
        setRunningScheduleId(null);
        await loadSchedules();
        return;
      }
      // Poll for session_id (run is async, session may not exist yet)
      let currentRun = run;
      let pollCount = 0;
      while (!currentRun.session_id && pollCount < 20) {
        await new Promise((r) => setTimeout(r, 1000));
        currentRun = await getScheduleRun(ctx, run.id);
        pollCount++;
        if (currentRun.status === 'failed' || currentRun.status === 'completed') break;
      }
      // Jump to chat under the schedule's template
      setTemplateId(schedule.template_id);
      setActivePanel('chat');
      if (currentRun.session_id) {
        currentSessionIdRef.current = currentRun.session_id;
        setCurrentSessionId(currentRun.session_id);
        await loadSessionEvents(currentRun.session_id);
        // Start streaming the session
        startStreamRef.current(currentRun.session_id);
      }
      await loadSchedules();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningScheduleId(null);
    }
  }, [ctx, loadSessionEvents, loadSchedules]);

  const handleDeleteSchedule = useCallback(async (scheduleId: string) => {
    if (!ctx) return;
    setError('');
    try {
      await archiveSchedule(ctx, scheduleId);
      await loadSchedules();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, loadSchedules]);

  const handleTogglePause = useCallback(async (schedule: ForwardSchedule) => {
    if (!ctx) return;
    try {
      if (schedule.status === 'active') {
        await pauseSchedule(ctx, schedule.id);
      } else {
        await unpauseSchedule(ctx, schedule.id);
      }
      await loadSchedules();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, loadSchedules]);

  const loadChannels = useCallback(async () => {
    if (!ctx || !identity) return;
    try {
      const page = await listChannels(ctx, identity.id);
      setChannels(page.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, identity]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const loadMemoryEntriesForTemplate = useCallback(async (tplId: string) => {
    if (!ctx || !identity || !tplId) return;
    try {
      // Get memory_store_id from effective endpoint's system_resources
      const spec = await getEffectiveSpec(ctx, identity.id, tplId);
      const memoryResource = spec.session?.system_resources?.find(
        (r) => r.type === 'memory_store' && r.memory_store_id
      );
      const storeId = memoryResource?.memory_store_id;
      setMemoryStoreId(storeId || '');

      if (storeId) {
        const entries = await listMemoryEntries(ctx, storeId);
        const entriesWithContent = await Promise.all(
          entries.data.map(async (entry) => {
            try {
              const full = await getMemoryEntry(ctx, storeId!, entry.id);
              return { ...entry, content: full.content };
            } catch {
              return { ...entry, content: undefined };
            }
          })
        );
        setMemoryEntries(entriesWithContent);
      } else {
        setMemoryEntries([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMemoryEntries([]);
    }
  }, [ctx, identity]);

  // QR confirmed 只代表扫码动作完成；渠道要处理上行消息必须 enabled=true 且
  // binding_status=bound。绑定生效前绝不能展示「绑定成功」，失败要给出可操作的提示。
  const confirmQrBinding = useCallback(async (channelId: string, opts?: { enable?: boolean }): Promise<ForwardChannel | null> => {
    if (!ctx) return null;
    setQrVerifying(true);
    setQrBindingIssue('');
    try {
      const channel = await waitForChannelBinding(ctx, channelId);
      if (channel.binding_status !== 'bound') {
        setQrBindingIssue(
          channel.binding_status === 'expired'
            ? '渠道授权已过期，请重新生成二维码扫码授权。'
            : '扫码已确认，但渠道暂未生效。绑定可能仍在处理中，请稍后点击「重新检查」，或重新生成二维码扫码。',
        );
        return null;
      }
      if (opts?.enable && !channel.enabled) {
        await updateChannel(ctx, channelId, { enabled: true });
        channel.enabled = true;
      }
      return channel;
    } catch (err) {
      setQrBindingIssue(`渠道生效失败：${err instanceof Error ? err.message : String(err)}。请检查网络后点击「重新检查」。`);
      return null;
    } finally {
      setQrVerifying(false);
    }
  }, [ctx]);

  const startQrSession = useCallback(async (channelId: string) => {
    if (!ctx) return;
    stopQrPolling();
    setQrBindingIssue('');
    setQrVerifying(false);
    try {
      const qr = await createQrSession(ctx, channelId);
      setQrSession(qr);
      setQrPolling(true);
      const pollInterval = (qr.poll_interval_seconds || 3) * 1000;
      const qrImage = qr.qr_code_image_base64;
      const qrContent = qr.qr_code_content;
      const pollFn = async () => {
        if (!qrPollTimerRef.current && qrPollTimerRef.current !== 0) return;
        try {
          const status = await getQrSession(ctx, qr.session_key);
          setQrSession({ ...status, qr_code_image_base64: qrImage, qr_code_content: qrContent });
          if (status.status === 'confirmed') {
            qrPollTimerRef.current = null;
            setQrPolling(false);
            // 扫码确认后先验证渠道真正生效，再展示成功并关闭弹窗
            const channel = await confirmQrBinding(channelId, { enable: true });
            if (channel) {
              await loadChannels();
              setShowChannelModal(false);
              setQrSession(null);
              setChanName('');
              setCreatedChannelId(null);
              setChannelStep('config');
            } else {
              await loadChannels().catch(() => {});
            }
          } else if (status.status === 'waiting' || status.status === 'scanned') {
            qrPollTimerRef.current = window.setTimeout(pollFn, pollInterval);
          } else {
            qrPollTimerRef.current = null;
            setQrPolling(false);
          }
        } catch { qrPollTimerRef.current = null; setQrPolling(false); }
      };
      qrPollTimerRef.current = window.setTimeout(pollFn, pollInterval);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, loadChannels, stopQrPolling, confirmQrBinding]);

  // Step 2 QR: create channel + generate QR code
  const handleCreateChannelAndQr = useCallback(async () => {
    if (!ctx || !identity || !chanName.trim()) return;
    const effectiveTemplateId = chanTemplateId || templates[0]?.id;
    if (!effectiveTemplateId) return;
    setLoading(true);
    setError('');
    try {
      const channel = await createChannel(ctx, {
        identity_id: identity.id,
        template_id: effectiveTemplateId,
        channel_type: chanType,
        name: chanName.trim(),
        enabled: false, // disabled until QR confirmed
        channel_config: {
          response_options: { include_tool_calls: chanShowTools, include_thinking: chanShowThinking },
        },
      });
      setCreatedChannelId(channel.id);
      await startQrSession(channel.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, identity, chanName, chanTemplateId, chanType, chanShowTools, chanShowThinking, templates, startQrSession]);

  const handleSaveCredentials = useCallback(async () => {
    if (!ctx || !identity) return;
    if (!chanAppKey.trim() || !chanAppSecret.trim()) return;
    setLoading(true);
    setError('');
    try {
      const credentials = buildChannelCredentials(chanType, chanAppKey.trim(), chanAppSecret.trim());
      if (chanAgentId.trim()) credentials.agent_id = chanAgentId.trim();
      // Create channel with credentials in one call (channel doesn't exist yet for manual mode)
      await createChannel(ctx, {
        identity_id: identity.id,
        template_id: chanTemplateId,
        channel_type: chanType,
        name: chanName.trim(),
        enabled: true,
        channel_config: {
          credentials,
          response_options: { include_tool_calls: chanShowTools, include_thinking: chanShowThinking },
        },
      });
      await loadChannels();
      setShowChannelModal(false);
      setChannelStep('config');
      setChanName('');
      setChanAppKey('');
      setChanAppSecret('');
      setChanAgentId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, identity, chanTemplateId, chanType, chanName, chanAppKey, chanAppSecret, chanAgentId, chanShowTools, chanShowThinking, loadChannels]);

  const handleRebindChannel = useCallback(async (channel: ForwardChannel) => {
    if (!ctx) return;
    stopQrPolling(); // stop any existing polling
    setQrBindingIssue('');
    setQrVerifying(false);
    try {
      const qr = await createQrSession(ctx, channel.id);
      setQrSession(qr);
      setQrPolling(true);
      const pollInterval = (qr.poll_interval_seconds || 3) * 1000;
      const qrImage = qr.qr_code_image_base64;
      const qrContent = qr.qr_code_content;
      const pollFn = async () => {
        if (!qrPollTimerRef.current && qrPollTimerRef.current !== 0) return;
        try {
          const status = await getQrSession(ctx, qr.session_key);
          setQrSession({ ...status, qr_code_image_base64: qrImage, qr_code_content: qrContent });
          if (status.status === 'confirmed') {
            qrPollTimerRef.current = null;
            setQrPolling(false);
            const fresh = await confirmQrBinding(channel.id);
            if (fresh) {
              setEditingChannelItem((prev) => (prev && prev.id === fresh.id ? { ...prev, ...fresh } : prev));
              setQrSession(null);
            }
            await loadChannels().catch(() => {});
          } else if (status.status === 'waiting' || status.status === 'scanned') {
            qrPollTimerRef.current = window.setTimeout(pollFn, pollInterval);
          } else {
            qrPollTimerRef.current = null;
            setQrPolling(false);
          }
        } catch { qrPollTimerRef.current = null; setQrPolling(false); }
      };
      qrPollTimerRef.current = window.setTimeout(pollFn, pollInterval);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, loadChannels, stopQrPolling, confirmQrBinding]);

  // 不重新扫码，仅重新检查渠道绑定状态（绑定可能异步生效）
  const handleRecheckBinding = useCallback(async (channelId: string, opts?: { enable?: boolean; closeOnBound?: boolean }) => {
    const channel = await confirmQrBinding(channelId, { enable: opts?.enable });
    await loadChannels().catch(() => {});
    if (!channel) return;
    setEditingChannelItem((prev) => (prev && prev.id === channel.id ? { ...prev, ...channel } : prev));
    if (opts?.closeOnBound) {
      setShowChannelModal(false);
      setQrSession(null);
      setChanName('');
      setCreatedChannelId(null);
      setChannelStep('config');
    } else {
      setQrSession(null);
    }
  }, [confirmQrBinding, loadChannels]);

  const handleDeleteChannel = useCallback(async (channelId: string) => {
    if (!ctx) return;
    setLoading(true);
    setError('');
    try {
      await deleteChannel(ctx, channelId);
      setDeleteChannelId(null);
      await loadChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, loadChannels]);

  const handleUpdateChannelItem = useCallback(async () => {
    if (!ctx || !editingChannelItem) return;
    setLoading(true);
    setError('');
    try {
      const updatePayload: Record<string, unknown> = {
        name: editingChannelItem.name,
        template_id: editingChannelItem.template_id,
        enabled: editingChannelItem.enabled,
        channel_config: editingChannelItem.channel_config,
      };
      // If manual mode and credentials provided, include them
      if (chanMode === 'manual' && chanAppKey.trim()) {
        const credentials = buildChannelCredentials(editingChannelItem.channel_type, chanAppKey.trim(), chanAppSecret.trim());
        if (chanAgentId.trim()) credentials.agent_id = chanAgentId.trim();
        updatePayload.channel_config = {
          ...editingChannelItem.channel_config,
          credentials,
        };
      }
      await updateChannel(ctx, editingChannelItem.id, updatePayload);
      stopQrPolling();
      setEditingChannelItem(null);
      setQrSession(null);
      setChanAppKey('');
      setChanAppSecret('');
      setChanAgentId('');
      await loadChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, editingChannelItem, chanMode, chanAppKey, chanAppSecret, chanAgentId, loadChannels, stopQrPolling]);

  const loadTemplateResourceOptions = useCallback(async () => {
    await Promise.all(TEMPLATE_RESOURCE_TYPES.map((type) => loadResources(type, false)));
  }, [loadResources]);

  const openTemplateModal = useCallback(() => {
    setEditingTemplateId(null);
    setTemplateName('');
    setTemplateDescription('');
    setTemplateSystem('');
    setEnvironmentId('');
    setSkillIdsText('');
    setFileIdsText('');
    setVaultIdsText('');
    setEnvVarsText('');
    setSelectedTools([...BUILTIN_TOOLS]);
    setToolsJson('');
    setMcpServersJson('');
    setMultiagentEnabled(false);
    setMultiagentSelectedAgentIds([]);
    setMultiagentIncludeSelf(false);
    setError('');
    setShowTemplateModal(true);
    void loadTemplateResourceOptions();
    if (ctx) { void loadModels(ctx); void loadManagedAgents(ctx); }
  }, [ctx, loadModels, loadManagedAgents, loadTemplateResourceOptions]);

  const openEditTemplateModal = useCallback((template: ForwardTemplate) => {
    setEditingTemplateId(template.id);
    setTemplateName(template.name || '');
    setTemplateDescription(template.description || '');
    setTemplateModel(getTemplateModelId(template.model) || 'ultimate');
    setTemplateSystem(template.system || '');
    setEnvironmentId(template.environment_id || '');
    // Skills → skill IDs
    setSkillIdsText(extractSkillInfo(template.skills).map((s) => s.id).filter(Boolean).join('\n'));
    // Files → file IDs (object keys)
    setFileIdsText(
      template.files && typeof template.files === 'object'
        ? Object.keys(template.files as Record<string, unknown>).join('\n')
        : '',
    );
    // Vaults
    setVaultIdsText((template.vault_ids ?? []).join('\n'));
    // Environment variables → KEY=value lines
    setEnvVarsText(
      template.environment_variables && typeof template.environment_variables === 'object'
        ? Object.entries(template.environment_variables as Record<string, unknown>)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join('\n')
        : '',
    );
    // Builtin tools → checkboxes; non-builtin tool entries preserved via toolsJson
    const builtinNames = extractToolNames(template.tools).filter((name) => BUILTIN_TOOLS.includes(name));
    setSelectedTools(builtinNames);
    const nonBuiltinTools = Array.isArray(template.tools)
      ? template.tools.filter((tool) => {
          if (!tool || typeof tool !== 'object') return false;
          return (tool as Record<string, unknown>).type !== 'agent_toolset_20260401';
        })
      : [];
    setToolsJson(nonBuiltinTools.length > 0 ? JSON.stringify(nonBuiltinTools, null, 2) : '');
    setMcpServersJson(
      Array.isArray(template.mcp_servers) && template.mcp_servers.length > 0
        ? JSON.stringify(template.mcp_servers, null, 2)
        : '',
    );
    // Multi-agent config → form state. The roster stores Managed Agent IDs;
    // self entries map to the include-self toggle, agent entries to chips.
    const ma = template.multiagent;
    const maAgents = ma && Array.isArray(ma.agents) ? ma.agents : [];
    setMultiagentEnabled(!!ma && ma.type === 'coordinator' && maAgents.length > 0);
    setMultiagentSelectedAgentIds(
      maAgents
        .filter((e: MultiagentAgentEntry) => e.type === 'agent' && typeof e.id === 'string')
        .map((e: MultiagentAgentEntry) => e.id as string),
    );
    setMultiagentIncludeSelf(maAgents.some((e: MultiagentAgentEntry) => e.type === 'self'));
    setError('');
    setViewingTemplate(null);
    setShowTemplateModal(true);
    void loadTemplateResourceOptions();
    if (ctx) { void loadModels(ctx); void loadManagedAgents(ctx); }
  }, [ctx, loadModels, loadManagedAgents, loadTemplateResourceOptions]);

  const connect = useCallback(async () => {
    if (!ctx || !externalId.trim()) {
      setError('请输入 PAT 和身份');
      return;
    }
    setLoading(true);
    setError('');
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify({
        apiEnvironment,
        pat: ctx.pat,
        externalId: externalId.trim(),
      }));
      const nextIdentity = await ensureIdentity(ctx, externalId.trim());
      setIdentity(nextIdentity);

      const templatePage = await listTemplates(ctx);
      setTemplates(templatePage.data);
      setActivePanel('chat');
      // Preload models for template creation dropdown
      void loadModels(ctx);

      // Check localStorage for last used template ID
      const lastTemplateKey = `last_template_${apiEnvironment}_${externalId.trim()}`;
      const lastTemplateId = localStorage.getItem(lastTemplateKey);
      const templateExists = lastTemplateId && templatePage.data.some((t) => t.id === lastTemplateId);
      const nextTemplateId = templateExists ? lastTemplateId! : (templatePage.data[0]?.id ?? '');

      setTemplateId(nextTemplateId);
      void loadResources(resourceType);
      if (nextTemplateId) {
        const sessionPage = await listSessions(ctx, nextIdentity.id, nextTemplateId);
        setSessions(sessionPage.data);
        // Don't auto-select a session - show empty chat welcome screen
        currentSessionIdRef.current = '';
        setCurrentSessionId('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiEnvironment, ctx, externalId, loadModels, loadResources, resourceType]);

  const registerCurrentResource = useCallback(async () => {
    if (!ctx || !resourceId.trim()) return;
    setLoading(true);
    setError('');
    try {
      const resource = await registerResource(ctx, resourceType, resourceId.trim());
      setResources((prev) => [resource, ...prev.filter((item) => item.id !== resource.id)]);
      setResourceOptionsByType((prev) => ({
        ...prev,
        [resource.type]: [resource, ...prev[resource.type].filter((item) => item.id !== resource.id)],
      }));
      setResourceId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, resourceId, resourceType]);

  const handleCreateEnvironment = useCallback(async () => {
    if (!ctx || !newEnvName.trim()) return;
    setLoading(true);
    setError('');
    try {
      const env = await createCloudEnvironment(ctx, {
        name: newEnvName.trim(),
        description: newEnvDescription.trim() || undefined,
        networking: newEnvNetworking,
      });
      await registerResource(ctx, 'environment', env.id, env.name);
      await loadResources('environment', true);
      setEnvironmentId(env.id);
      setNewEnvName('');
      setNewEnvDescription('');
      setNewEnvNetworking('limited');
      setShowCreateEnvModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, newEnvName, newEnvDescription, newEnvNetworking, loadResources]);

  const activeResourceType = resourceTypeForPanel(activePanel) ?? 'skill';
  const activeResourceLabel = RESOURCE_TYPE_LABELS[activeResourceType];

  const handleCreateResource = useCallback(async () => {
    if (!ctx || !newResName.trim()) return;
    setLoading(true);
    setError('');
    try {
      const name = newResName.trim();
      const desc = newResDesc.trim();
      let createdId = '';

      switch (activeResourceType) {
        case 'environment': {
          const env = await createCloudEnvironment(ctx, { name, description: desc, networking: newResNetworking });
          createdId = env.id;
          break;
        }
        case 'vault': {
          const vault = await createCloudVault(ctx, { display_name: name });
          createdId = vault.id;
          break;
        }
        case 'skill': {
          if (!newResFile) throw new Error('请选择技能文件（.zip 格式，包含 SKILL.md）');
          const skill = await uploadCloudSkill(ctx, { name, description: desc || undefined, file: newResFile });
          createdId = skill.id;
          break;
        }
        case 'file': {
          if (!newResFile) throw new Error('请选择要上传的文件');
          const file = await uploadCloudFile(ctx, { file: newResFile, name });
          createdId = file.id;
          break;
        }
        default:
          throw new Error('暂不支持创建此类型资源');
      }

      // Auto-register with Forward
      await registerResource(ctx, activeResourceType, createdId, name);
      await loadResources(activeResourceType);
      setShowCreateResourceModal(false);
      setNewResName('');
      setNewResDesc('');
      setNewResNetworking('limited');
      setNewResFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, newResName, newResDesc, newResNetworking, newResFile, activeResourceType, loadResources]);

  const handleDeleteResource = useCallback(async () => {
    if (!ctx || !deleteConfirmResource) return;
    const resource = deleteConfirmResource;
    setDeleteConfirmResource(null);
    setLoading(true);
    setError('');
    try {
      // Try Forward API delete first (handles both CAS + registry)
      try {
        await deleteForwardResource(ctx, resource.id);
      } catch (err) {
        // Fallback: delete via Cloud API directly if Forward DELETE not available
        if (err instanceof ForwardApiError && err.status === 404) {
          switch (resource.type) {
            case 'skill': await deleteCloudSkill(ctx, resource.id); break;
            case 'file': await deleteCloudFile(ctx, resource.id); break;
            case 'environment': await deleteCloudEnvironment(ctx, resource.id); break;
            case 'vault': await deleteCloudVault(ctx, resource.id); break;
            default: throw err;
          }
        } else {
          throw err;
        }
      }
      await loadResources(resource.type);
      setViewingResource(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, deleteConfirmResource, loadResources]);

  const openEditModal = useCallback((resource: ForwardResource) => {
    setEditingResource(resource);
    setEditName(resource.name || specString(resource, 'display_title', 'display_name', 'name') || '');
    setEditDesc(resource.description || specString(resource, 'description') || '');
    setVaultCredentials([]);
    setNewCredType('static_bearer');
    setNewCredUrl('');
    setNewCredToken('');
    setNewCredSecretName('');
    setNewCredSecretValue('');
    setNewCredAccessToken('');
    setNewCredExpiresAt('');
    if (resource.type === 'environment') {
      const config = resource.resource_spec?.config as Record<string, unknown> | undefined;
      const networking = config?.networking as { type?: string } | undefined;
      setEditNetworking(networking?.type === 'unrestricted' ? 'unrestricted' : 'limited');
    }
    if (resource.type === 'vault' && ctx) {
      listCloudCredentials(ctx, resource.id)
        .then((res) => setVaultCredentials(res.data || []))
        .catch(() => setVaultCredentials([]));
    }
  }, [ctx]);

  const handleSaveEdit = useCallback(async () => {
    if (!ctx || !editingResource) return;
    setLoading(true);
    setError('');
    try {
      const name = editName.trim();
      const desc = editDesc.trim();
      switch (editingResource.type) {
        case 'environment':
          await updateCloudEnvironment(ctx, editingResource.id, {
            ...(name ? { name } : {}),
            description: desc,
            config: { type: 'cloud', networking: { type: editNetworking } },
          });
          break;
        case 'skill':
          await updateCloudSkill(ctx, editingResource.id, {
            ...(name ? { name } : {}),
            description: desc,
          });
          break;
        case 'vault':
          // Vault display_name update not supported via Cloud API
          // Credential management handled separately
          break;
        default:
          throw new Error('暂不支持编辑此类型资源');
      }
      await loadResources(editingResource.type);
      setEditingResource(null);
      setViewingResource(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx, editingResource, editName, editDesc, editNetworking, loadResources]);

  const buildTemplateInput = useCallback(() => {
    const explicitTools = parseJsonArray(toolsJson, '工具 JSON');
    const tools = explicitTools.length > 0
      ? explicitTools
      : selectedTools.length > 0
        ? [{
            type: 'agent_toolset_20260401',
            configs: selectedTools.map((name) => ({ name, enabled: true })),
          }]
        : [];
    const fileIds = splitTokens(fileIdsText);
    // Toolset prerequisite: multiagent only takes effect when the tools array
    // contains an agent_toolset_20260401 entry. The UI also gates on this, but
    // buildTemplateInput double-checks so a saved template never has a
    // multiagent block without a toolset.
    const hasToolset = tools.some(
      (t) => t && typeof t === 'object' && (t as Record<string, unknown>).type === 'agent_toolset_20260401',
    );
    const rosterAgents: MultiagentAgentEntry[] = multiagentSelectedAgentIds
      .map((id) => {
        const agent = managedAgents.find((a) => a.id === id);
        return { type: 'agent' as const, id, ...(agent?.name ? { name: agent.name } : {}) };
      });
    const multiagent: MultiagentConfig | null =
      multiagentEnabled && hasToolset && (rosterAgents.length > 0 || multiagentIncludeSelf)
        ? {
            type: 'coordinator',
            agents: [
              ...rosterAgents,
              ...(multiagentIncludeSelf ? [{ type: 'self' as const }] : []),
            ],
          }
        : null;

    return {
      name: templateName,
      description: templateDescription,
      model: templateModel,
      system: templateSystem,
      environment_id: environmentId,
      vault_ids: splitTokens(vaultIdsText),
      skills: splitTokens(skillIdsText).map((skillId) => ({ type: 'custom', skill_id: skillId })),
      files: Object.fromEntries(fileIds.map((fileId) => [fileId, {}])),
      environment_variables: parseEnvironmentVariables(envVarsText),
      tools,
      mcp_servers: parseJsonArray(mcpServersJson, 'MCP 服务 JSON'),
      multiagent,
    };
  }, [
    selectedTools,
    environmentId,
    envVarsText,
    fileIdsText,
    managedAgents,
    mcpServersJson,
    multiagentEnabled,
    multiagentIncludeSelf,
    multiagentSelectedAgentIds,
    skillIdsText,
    templateDescription,
    templateModel,
    templateName,
    templateSystem,
    toolsJson,
    vaultIdsText,
  ]);

  // Whether the tools config includes an agent_toolset_20260401 entry — the
  // hard prerequisite for multiagent. Drives the UI gate in the editor.
  const toolsetConfigured = useMemo(() => {
    if (selectedTools.length > 0) return true;
    try {
      return parseJsonArray(toolsJson, '').some(
        (t) => t && typeof t === 'object' && (t as Record<string, unknown>).type === 'agent_toolset_20260401',
      );
    } catch { return false; }
  }, [selectedTools, toolsJson]);

  const createDefaultTemplate = useCallback(async () => {
    if (!ctx) return;
    setLoading(true);
    setError('');
    try {
      const template = await createTemplate(ctx, buildTemplateInput());
      setTemplates((prev) => [template, ...prev]);
      setTemplateId(template.id);
      await refreshSessions(identity, template.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [buildTemplateInput, ctx, identity, refreshSessions]);

  const updateExistingTemplate = useCallback(async () => {
    if (!ctx || !editingTemplateId) return;
    setLoading(true);
    setError('');
    try {
      const updated = await updateTemplate(ctx, editingTemplateId, buildTemplateInput());
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [buildTemplateInput, ctx, editingTemplateId]);

  const selectSession = useCallback(async (sessionId: string) => {
    setActivePanel('chat');
    stickToBottomRef.current = true;
    currentSessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
    setEvents([]);
    setError('');
    setSessionLoading(true);
    streamAbort.current?.abort();
    try {
      const page = await listEvents(ctx!, sessionId);
      // Events are returned in descending order (newest first), reverse to chronological order
      const chronologicalData = [...page.data].reverse();
      setEvents(chronologicalData);
      // Check if session is still active and restart stream if needed
      const session = sessions.find((s) => s.id === sessionId);
      if (session && (session.status === 'running' || session.status === 'processing')) {
        // Add a local thinking event to show loading indicator
        const thinkingId = `local-thinking-${sessionId}-${Date.now()}`;
        const thinkingEvent: ForwardEvent = {
          id: thinkingId,
          type: 'agent.thinking',
          session_id: sessionId,
          created_at: new Date().toISOString(),
          content: 'AI 正在思考...',
        };
        setEvents((prev) => [...prev, thinkingEvent]);
        // Pass the last event ID to resume stream from the correct position
        const lastEventId = chronologicalData.length > 0 ? chronologicalData[chronologicalData.length - 1].id : undefined;
        // If the session has ever had multiagent threads (tracked in
        // multiagentSessionsRef), pass this so child thread_status_idle
        // doesn't prematurely terminate the stream. NOTE: listEvents uses
        // LIST_EVENT_TYPES which does NOT include session.thread_created, so
        // we can't rely on fetched events for this check — the ref is the
        // source of truth.
        const hasMA = multiagentSessionsRef.current.has(sessionId);
        startStreamRef.current(sessionId, lastEventId, undefined, hasMA);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only clear the spinner if the user hasn't switched to another session meanwhile.
      if (currentSessionIdRef.current === sessionId) setSessionLoading(false);
    }
  }, [ctx, sessions]);

  const startStream = useCallback((sessionId: string, lastEventId?: string, turnStartedAt?: string, initialHasMultiagent?: boolean) => {
    if (!ctx) return;
    streamAbort.current?.abort();
    const controller = new AbortController();
    let pollTimer: number | undefined;
    let reconnecting = false;
    // Track whether this session has spawned child threads (multiagent mode).
    // In multiagent mode, child thread_status_idle must NOT terminate the SSE
    // stream — only session.status_idle signals session-level completion.
    let hasMultiagentThreads = !!initialHasMultiagent;
    // Throttle streaming UI updates so fast/long responses don't overwhelm the main
    // thread. Text deltas are coalesced and the synthetic streaming message is
    // flushed at most once per FLUSH_INTERVAL_MS, always with the latest text.
    const FLUSH_INTERVAL_MS = 100;
    let streamFlushTimer: number | null = null;
    let lastStreamFlush = 0;
    const flushStreamingText = () => {
      streamFlushTimer = null;
      lastStreamFlush = Date.now();
      // Don't paint into the view if the user has navigated away from this session
      // (e.g. opened the new-conversation screen while this stream keeps running).
      if (currentSessionIdRef.current !== sessionId) return;
      const text = _streamingTextBySession.get(sessionId);
      const msgId = _streamingMsgIdBySession.get(sessionId);
      if (text == null || !msgId) return;
      const streamEvent: ForwardEvent = {
        id: msgId,
        type: 'agent.message',
        session_id: sessionId,
        created_at: new Date().toISOString(),
        content: [{ type: 'text', text }],
      };
      setEvents((prev) => {
        const idx = prev.findIndex((e) => e.id === msgId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = streamEvent;
          return next;
        }
        return [...prev, streamEvent];
      });
    };
    const scheduleStreamFlush = () => {
      if (streamFlushTimer != null) return;
      const elapsed = Date.now() - lastStreamFlush;
      if (elapsed >= FLUSH_INTERVAL_MS) {
        flushStreamingText();
      } else {
        streamFlushTimer = window.setTimeout(flushStreamingText, FLUSH_INTERVAL_MS - elapsed);
      }
    };
    const cancelStreamFlush = () => {
      if (streamFlushTimer != null) {
        window.clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
      }
    };
    const stopPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };
    const finishStream = () => {
      // Flush any pending streaming text so the user sees the latest content
      // before the stream terminates.
      flushStreamingText();
      cancelStreamFlush();
      stopPolling();
      controller.abort();
      setStreaming(false);
    };
    const syncLatestEvents = async () => {
      const page = await mergeSessionEvents(sessionId);
      await refreshSessions();
      // Only check events from the CURRENT turn to avoid old session.status_idle
      // from a previous turn prematurely closing the SSE connection
      const newEvents = turnStartedAt
        ? (page?.data ?? []).filter((e) => (e.created_at || e.processed_at || '') > turnStartedAt)
        : (page?.data ?? []);
      // Update multiagent tracking from polled events (thread_created may arrive
      // via polling rather than SSE).
      if (newEvents.some((e) => e.type === 'session.thread_created')) {
        hasMultiagentThreads = true;
      }
      if (newEvents.some((e) => isTerminalSessionEvent(e, hasMultiagentThreads))) {
        finishStream();
      }
    };
    controller.signal.addEventListener('abort', () => {
      cancelStreamFlush();
      stopPolling();
      if (!reconnecting) setStreaming(false);
    }, { once: true });
    pollTimer = window.setInterval(() => {
      if (reconnecting) return; // Skip polling during reconnection
      void syncLatestEvents().catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    }, 1500);
    streamAbort.current = controller;
    setStreaming(true);
    void streamEvents(
      ctx,
      sessionId,
      (event) => {
        // New turn started — reset accumulators for this session
        if (event.type === 'session.status_running') {
          cancelStreamFlush();
          lastStreamFlush = 0;
          _thinkingBySession.set(sessionId, '');
          _streamingTextBySession.delete(sessionId);
          _streamingMsgIdBySession.delete(sessionId);
          // Remove old synthetic streaming messages from a previous turn.
          setEvents((prev) => prev.filter((e) => !e.id.startsWith('local-stream-')));
        }
        // Track child thread creation for multiagent terminal-event gating.
        if (event.type === 'session.thread_created') {
          hasMultiagentThreads = true;
          multiagentSessionsRef.current.add(sessionId);
        }

        // Accumulate deltas from incremental streaming events.
        // thinking_delta → accumulate for agent.thinking event injection
        // text_delta → accumulate for real-time streaming display
        if (event.type === 'agent.content_block_delta') {
          const delta = event.delta as { type?: string; thinking?: string; text?: string } | undefined;
          if (delta?.type === 'thinking_delta' && delta.thinking) {
            _thinkingBySession.set(sessionId, (_thinkingBySession.get(sessionId) ?? '') + delta.thinking);
          }
          if (delta?.type === 'text_delta' && delta.text) {
            const prev = _streamingTextBySession.get(sessionId) ?? '';
            const updated = prev + delta.text;
            _streamingTextBySession.set(sessionId, updated);
            // Ensure a stable synthetic message id exists, then throttle the flush
            // so we re-render at most ~10 times/second regardless of delta rate.
            if (!_streamingMsgIdBySession.get(sessionId)) {
              _streamingMsgIdBySession.set(sessionId, `local-stream-${sessionId}-${Date.now()}`);
            }
            scheduleStreamFlush();
          }
          return; // Skip adding delta events to the event list
        }
        // Also skip other incremental framing events
        if (
          event.type === 'agent.message_start' ||
          event.type === 'agent.content_block_start' ||
          event.type === 'agent.content_block_stop' ||
          event.type === 'agent.message_delta' ||
          event.type === 'agent.message_stop'
        ) {
          return;
        }

        // When agent.message arrives, inject accumulated thinking into the
        // agent.thinking event (which arrives empty from the API), and replace
        // the synthetic streaming message with the real final message.
        if (event.type === 'agent.message') {
          cancelStreamFlush();
          const thinkingText = _thinkingBySession.get(sessionId) ?? '';
          _thinkingBySession.delete(sessionId);
          const streamMsgId = _streamingMsgIdBySession.get(sessionId);
          _streamingTextBySession.delete(sessionId);
          _streamingMsgIdBySession.delete(sessionId);

          if (currentSessionIdRef.current !== sessionId) {
            // View moved to another session / new-conversation screen: skip painting.
          } else if (thinkingText) {
            setEvents((prev) => {
              // Remove synthetic streaming message if present
              const cleaned = streamMsgId ? prev.filter((e) => e.id !== streamMsgId) : [...prev];
              // Deduplicate: if the previous agent.message has >60% similar
              // content, remove it (coordinator sometimes outputs the same
              // report twice — a draft then a "verified" version).
              const next = deduplicateAgentMessage(cleaned, sessionId, event);
              // Find the last agent.thinking event for this session and update it
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].type === 'agent.thinking' && next[i].session_id === sessionId) {
                  next[i] = { ...next[i], content: [{ type: 'text', text: thinkingText }] };
                  break;
                }
              }
              return mergeIncomingEvents(next, [event]);
            });
          } else {
            setEvents((prev) => {
              const cleaned = streamMsgId ? prev.filter((e) => e.id !== streamMsgId) : prev;
              const next = deduplicateAgentMessage(cleaned, sessionId, event);
              return mergeIncomingEvents(next, [event]);
            });
          }
        } else {
          // Skip stray multiagent thread events (session.thread_status_idle etc.)
          // for sessions that don't have multiagent threads. These events may
          // arrive from the backend when a child thread from a PREVIOUS
          // multiagent session is still running and its status events leak
          // into the new session's SSE stream.
          const isStrayMultiagentEvent = !hasMultiagentThreads && (
            event.type === 'session.thread_status_idle' ||
            event.type === 'session.thread_status_running' ||
            event.type === 'agent.thread_message_sent' ||
            event.type === 'agent.thread_message_received'
          );
          if (!isStrayMultiagentEvent && currentSessionIdRef.current === sessionId) {
            setEvents((prev) => mergeIncomingEvents(prev, [event]));
          }
        }

        // Auto-confirm tool calls when session enters requires_action
        if (event.type === 'session.status_idle') {
          const stopReason = (event as unknown as { stop_reason?: { type?: string; event_ids?: string[] } }).stop_reason;
          if (stopReason?.type === 'requires_action' && stopReason.event_ids?.length && ctx) {
            reconnecting = true; // Prevent .then() from interfering
            // Automatically allow all pending tool confirmations, then reconnect stream
            const confirmAndReconnect = async () => {
              for (const toolEventId of stopReason.event_ids!) {
                await fetch('/api/forward/request', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    pat: ctx.pat,
                    environment: (ctx as unknown as { environment?: string }).environment || 'cn-prod',
                    method: 'POST',
                    path: `/sessions/${encodeURIComponent(sessionId)}/events`,
                    body: { events: [{ type: 'user.tool_confirmation', tool_use_id: toolEventId, result: 'allow' }] },
                    idempotencyKey: `fw-confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  }),
                }).catch(() => { /* ignore */ });
              }
              // Wait then reconnect stream to get new events
              await new Promise((r) => setTimeout(r, 800));
              // Reconnect using the last event id, preserving multiagent tracking
              startStreamRef.current?.(sessionId, event.id, undefined, hasMultiagentThreads);
            };
            void confirmAndReconnect();
            return; // Don't check isTerminal - we're handling reconnection
          }
          // requires_action but nothing actionable to confirm (empty event_ids or
          // missing ctx): end the turn instead of hanging, because isTerminalSessionEvent
          // treats requires_action as non-terminal and the upstream keeps the SSE alive
          // with heartbeats until its ~10min timeout.
          if (stopReason?.type === 'requires_action') {
            finishStream();
            void mergeSessionEvents(sessionId);
            void refreshSessions();
            return;
          }
        }
        if (isTerminalSessionEvent(event, hasMultiagentThreads)) {
          finishStream();
          void mergeSessionEvents(sessionId);
          void refreshSessions();
        }
      },
      controller.signal,
      lastEventId,
    ).then(() => {
      // Don't interfere if we're reconnecting due to requires_action
      if (reconnecting) return;
      if (!controller.signal.aborted) {
        void syncLatestEvents().catch((err) => {
          if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
        });
      }
    }).catch((err) => {
      if (!controller.signal.aborted && !reconnecting) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (reconnecting) return;
      // Once the SSE stream ends (server closed it on a terminal event, or we aborted
      // locally), always clear the streaming flag for the current turn so the composer
      // is never left permanently disabled.
      if (streamAbort.current === controller) {
        setStreaming(false);
      }
    });
  }, [ctx, mergeSessionEvents, refreshSessions]);
  startStreamRef.current = startStream;

  useEffect(() => {
    startStreamRef.current = startStream;
  }, [startStream]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!ctx || !identity || !templateId) return;
    // Block sending only while the on-screen session is processing; starting a
    // brand-new conversation is always allowed even if a background task runs.
    if (stopping) return;
    if (streaming && currentSessionId) return;
    // Wait until every attachment finished uploading (or was removed) —
    // sending with a half-uploaded attachment would confuse the agent.
    if (attachments.some((a) => a.status !== 'done')) return;
    const readyAttachments = attachments.filter((a) => a.fileId && a.storedName);
    if (!text && readyAttachments.length === 0) return;
    // Dedupe mount names within this batch so same-named files don't collide
    // on the workspace path.
    const usedNames = new Set<string>();
    const mountNames = readyAttachments.map((a) => {
      let name = a.storedName!;
      if (usedNames.has(name)) name = `${a.fileId}-${name}`;
      usedNames.add(name);
      return name;
    });
    const displayText = text || '请查看我上传的附件。';
    const finalText = composeMessageWithAttachments(displayText, mountNames);
    const turnStartedAt = new Date().toISOString();
    let localThinkingId = '';
    setInput('');
    setError('');
    try {
      let sessionId = currentSessionId;
      if (!sessionId) {
        const session = await createSession(ctx, identity.id, templateId, sessionTitle(displayText), readyAttachments.map((a) => a.fileId!));
        setSessions((prev) => [session, ...prev]);
        // Sync the ref immediately: startStream below runs before the effect that
        // mirrors currentSessionId into the ref, and its guards need the new id.
        currentSessionIdRef.current = session.id;
        setCurrentSessionId(session.id);
        sessionId = session.id;
      } else {
        // Existing session: mount each attachment into the agent workspace
        // BEFORE the message lands, so the agent can read it immediately.
        for (let i = 0; i < readyAttachments.length; i += 1) {
          await addSessionFileResource(ctx, sessionId, {
            file_id: readyAttachments[i].fileId!,
            mount_path: attachmentMountPath(mountNames[i]),
          });
        }
      }
      recordTurnStart(sessionId);
      const localEvents = localTurnEvents(sessionId, finalText);
      localThinkingId = localEvents.thinking.id;
      // Sending a new message should always bring the view back to the bottom.
      stickToBottomRef.current = true;
      // Remove old synthetic streaming messages from a previous turn that may
      // not have been cleaned up (e.g. stream terminated before agent.message
      // arrived). Also clear the streaming accumulators.
      _streamingTextBySession.delete(sessionId);
      _streamingMsgIdBySession.delete(sessionId);
      setEvents((prev) => {
        const cleaned = prev.filter((e) => !e.id.startsWith('local-stream-'));
        return [...cleaned, localEvents.user, localEvents.thinking];
      });
      const result = await sendUserMessage(ctx, sessionId, finalText);
      setEvents((prev) => mergeIncomingEvents(prev, result.data ?? []));
      setAttachments([]);
      startStream(sessionId, lastRemoteEventId(result.data ?? []), turnStartedAt, multiagentSessionsRef.current.has(sessionId));
      window.setTimeout(() => {
        void mergeSessionEvents(sessionId);
        void refreshSessions();
      }, 1200);
      window.setTimeout(() => {
        void mergeSessionEvents(sessionId);
        void refreshSessions();
      }, 3500);
    } catch (err) {
      if (localThinkingId) {
        setEvents((prev) => prev.filter((event) => event.id !== localThinkingId));
      }
      setError(err instanceof Error ? err.message : String(err));
      setInput(text);
    }
  }, [attachments, ctx, currentSessionId, identity, input, mergeSessionEvents, refreshSessions, startStream, templateId, streaming, stopping]);

  const sendQuick = useCallback(async (text: string) => {
    if (!ctx || !identity || !templateId || !text.trim()) return;
    const turnStartedAt = new Date().toISOString();
    let localThinkingId = '';
    setInput('');
    setError('');
    try {
      let sessionId = currentSessionId;
      if (!sessionId) {
        const session = await createSession(ctx, identity.id, templateId, sessionTitle(text));
        setSessions((prev) => [session, ...prev]);
        currentSessionIdRef.current = session.id;
        setCurrentSessionId(session.id);
        sessionId = session.id;
      }
      recordTurnStart(sessionId);
      const localEvents = localTurnEvents(sessionId, text);
      localThinkingId = localEvents.thinking.id;
      // Sending a new message should always bring the view back to the bottom.
      stickToBottomRef.current = true;
      // Remove old synthetic streaming messages from a previous turn.
      _streamingTextBySession.delete(sessionId);
      _streamingMsgIdBySession.delete(sessionId);
      setEvents((prev) => {
        const cleaned = prev.filter((e) => !e.id.startsWith('local-stream-'));
        return [...cleaned, localEvents.user, localEvents.thinking];
      });
      const result = await sendUserMessage(ctx, sessionId, text);
      setEvents((prev) => mergeIncomingEvents(prev, result.data ?? []));
      startStream(sessionId, lastRemoteEventId(result.data ?? []), turnStartedAt, multiagentSessionsRef.current.has(sessionId));
      window.setTimeout(() => {
        void mergeSessionEvents(sessionId);
        void refreshSessions();
      }, 1200);
      window.setTimeout(() => {
        void mergeSessionEvents(sessionId);
        void refreshSessions();
      }, 3500);
    } catch (err) {
      if (localThinkingId) {
        setEvents((prev) => prev.filter((event) => event.id !== localThinkingId));
      }
      setError(err instanceof Error ? err.message : String(err));
      setInput(text);
    }
  }, [ctx, currentSessionId, identity, mergeSessionEvents, refreshSessions, startStream, templateId]);

  const stop = useCallback(async () => {
    if (!ctx || !currentSessionId || stopping) return;
    streamAbort.current?.abort();
    setStreaming(false);
    setStopping(true);
    setError('');
    try {
      const result = await cancelSession(ctx, currentSessionId);
      setSessions((prev) => prev.map((session) => (
        session.id === currentSessionId ? { ...session, status: result.status || 'canceling' } : session
      )));
      setEvents((prev) => [
        ...prev.filter((event) => !(isLocalThinkingEvent(event) && event.session_id === currentSessionId)),
        {
          id: `local-${Date.now()}-cancel`,
          type: 'session.cancel_requested',
          session_id: currentSessionId,
          created_at: new Date().toISOString(),
          status: result.status || 'canceling',
          reason: '已请求停止当前对话',
        },
      ]);
      await loadSessionEvents(currentSessionId);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }, [ctx, currentSessionId, loadSessionEvents, refreshSessions, stopping]);

  const logout = useCallback(() => {
    streamAbort.current?.abort();
    localStorage.removeItem(AUTH_KEY);
    setIdentity(null);
    setTemplates([]);
    setTemplateId('');
    setSessions([]);
    setResources([]);
    setResourceOptionsByType(emptyResourceOptions());
    setCurrentSessionId('');
    setEvents([]);
    setError('');
    setActivePanel('chat');
  }, []);

  const currentTemplate = templates.find((template) => template.id === templateId);
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const hasPendingLocalThinking = events.some((event) => isLocalThinkingEvent(event) && event.session_id === currentSessionId);
  const currentSessionStatus = currentSession?.status;
  const isCurrentTurnCanceling = stopping ||
    currentSessionStatus === 'canceling' ||
    currentSessionStatus === 'cancelling';
  const canStopCurrentTurn = Boolean(
    currentSessionId &&
    !isCurrentTurnCanceling &&
    (streaming || hasPendingLocalThinking || currentSessionStatus === 'running' || currentSessionStatus === 'processing'),
  );
  const attachmentsBusy = attachments.some((a) => a.status !== 'done');
  const canSendMessage = Boolean(
    identity && templateId && !attachmentsBusy && (input.trim() || attachments.length > 0),
  );
  const displayName = externalId || identity?.external_id || identity?.id || 'Forward 用户';
  const selectedSkillIds = splitTokens(skillIdsText);
  const selectedFileIds = splitTokens(fileIdsText);
  const selectedVaultIds = splitTokens(vaultIdsText);
  const environmentOptions = resourceOptionsByType.environment;
  const addSelection = (id: string, setter: Dispatch<SetStateAction<string>>) => {
    setter((prev) => splitTokens(`${prev}\n${id}`).join('\n'));
  };
  const removeSelection = (id: string, setter: Dispatch<SetStateAction<string>>) => {
    setter((prev) => splitTokens(prev).filter((item) => item !== id).join('\n'));
  };

  if (!identity) {
    return (
      <div className="flex min-h-screen flex-col bg-[#FAFBFF]">
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-[420px]">
            <div className="mb-8 text-center">
              <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white shadow-[0_2px_12px_rgba(53,80,255,0.08)]">
                <BrandIcon className="h-8 w-8" rounded="rounded-xl" />
              </div>
              <h1 className="text-[22px] font-semibold text-black">欢迎使用 {PRODUCT_NAME}</h1>
              <p className="mt-2 text-sm text-black/45">快速创建 AI Agent，开始智能对话</p>
            </div>
            <div className="rounded-2xl bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(47,58,128,0.06)]">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void connect();
                }}
                className="flex flex-col gap-4"
              >
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-black/50">API 环境</span>
                  <ApiEnvironmentSelect
                    value={apiEnvironment}
                    onChange={(nextEnvironment) => {
                      setApiEnvironment(nextEnvironment);
                      setError('');
                    }}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-black/50">
                    访问令牌 (PAT)
                  </span>
                  <input
                    value={pat}
                    onChange={(event) => {
                      setPat(event.target.value);
                      setError('');
                    }}
                    placeholder="粘贴你的 Personal Access Token"
                    className="h-11 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition placeholder:text-black/25 focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-black/50">用户身份</span>
                  <input
                    value={externalId}
                    onChange={(event) => {
                      setExternalId(event.target.value);
                      setError('');
                    }}
                    placeholder="输入你的用户标识，如 user-001"
                    className="h-11 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition placeholder:text-black/25 focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                  />
                </label>
                {error && (
                  <div className="flex items-center gap-2 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">
                    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  disabled={loading || !pat.trim() || !externalId.trim()}
                  onClick={() => void connect()}
                  className="mt-2 flex h-11 w-full items-center justify-center rounded-xl bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      连接中...
                    </span>
                  ) : '开始使用'}
                </button>
              </form>
            </div>
            <p className="mt-5 text-center text-xs text-black/30">
              需要 PAT？前往{' '}
              <a
                href={apiEnvironment === 'cn-prod' ? 'https://qoder.com.cn/cloud/pat-keys' : 'https://qoder.com/cloud/pat-keys'}
                target="_blank"
                rel="noreferrer"
                className="text-[#3550FF] hover:underline"
              >
                Qoder 控制台
              </a>{' '}
              获取访问令牌
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-row overflow-hidden bg-white text-black">
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex min-h-0 flex-1 flex-row overflow-hidden">

        {/* Sidebar */}
        {!sidebarCollapsed && (
        <aside className="flex h-full w-[250px] shrink-0 flex-col border-r border-[#EEF0F6] bg-[#FAFBFF]">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col px-3 py-3">
              {/* Logo + collapse */}
              <div className="mb-1 flex items-center justify-between px-1 py-1.5">
                <div className="flex items-center gap-2">
                  <BrandIcon className="h-7 w-7" rounded="rounded-lg" />
                  <span className="text-[15px] font-semibold text-black">{PRODUCT_NAME}</span>
                </div>
                <button onClick={() => setSidebarCollapsed(true)} className="flex h-7 w-7 items-center justify-center rounded-md text-black/40 transition hover:bg-gray-200 hover:text-black" title="收起侧边栏">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" /></svg>
                </button>
              </div>

              {/* Navigation entries */}
              <div className="mt-2 space-y-0.5">
                <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wider text-black/30">主菜单</div>
                {SIDEBAR_ITEMS.slice(0, 5).map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => {
                      setActivePanel(id);
                      const nextType = resourceTypeForPanel(id);
                      if (nextType && nextType !== 'memory_store') {
                        setResourceType(nextType);
                        setResources([]);
                        void loadResources(nextType);
                      }
                      if (id === 'memoryStores') {
                        // Default to the template used by the active chat session so the
                        // memory menu reads the same memory store you just talked to.
                        const activeTpl = sessions.find((s) => s.id === currentSessionId)?.template_id;
                        const tplId = activeTpl || templateId || templates[0]?.id || '';
                        setMemoryTemplateId(tplId);
                        void loadMemoryEntriesForTemplate(tplId);
                      }
                      if (id === 'schedules') void loadSchedules();
                      if (id === 'channels') void loadChannels();
                    }}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition ${
                      activePanel === id ? 'bg-[#3550FF]/8 font-semibold text-[#3550FF]' : 'font-medium text-black/55 hover:bg-black/4 hover:text-black'
                    }`}
                  >
                    <NavIcon panel={id} />
                    {label}
                  </button>
                ))}
                {developerMode && (
                  <div className="mb-2 mt-5 px-2 text-[11px] font-medium uppercase tracking-wider text-black/30">模板资源</div>
                )}
                {developerMode && SIDEBAR_ITEMS.slice(5, 9).map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => {
                      setActivePanel(id);
                      const nextType = resourceTypeForPanel(id);
                      if (nextType && nextType !== 'memory_store') {
                        setResourceType(nextType);
                        setResources([]);
                        void loadResources(nextType);
                      }
                      if (id === 'memoryStores') {
                        // Default to the template used by the active chat session so the
                        // memory menu reads the same memory store you just talked to.
                        const activeTpl = sessions.find((s) => s.id === currentSessionId)?.template_id;
                        const tplId = activeTpl || templateId || templates[0]?.id || '';
                        setMemoryTemplateId(tplId);
                        void loadMemoryEntriesForTemplate(tplId);
                      }
                    }}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition ${
                      activePanel === id ? 'bg-[#3550FF]/8 font-semibold text-[#3550FF]' : 'font-medium text-black/55 hover:bg-black/4 hover:text-black'
                    }`}
                  >
                    <NavIcon panel={id} />
                    {label}
                  </button>
                ))}
                <div className="mb-2 mt-5 px-2 text-[11px] font-medium uppercase tracking-wider text-black/30">统计</div>
                {SIDEBAR_ITEMS.slice(9).map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => {
                      setActivePanel(id);
                      const nextType = resourceTypeForPanel(id);
                      if (nextType) {
                        setResourceType(nextType);
                        setResources([]);
                        void loadResources(nextType);
                      }
                    }}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition ${
                      activePanel === id ? 'bg-[#3550FF]/8 font-semibold text-[#3550FF]' : 'font-medium text-black/55 hover:bg-black/4 hover:text-black'
                    }`}
                  >
                    <NavIcon panel={id} />
                    {label}
                  </button>
                ))}
              </div>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Developer mode toggle */}
              <div className="shrink-0">
                <div className="flex items-center justify-between gap-2 rounded-xl px-2.5 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <svg className="h-4 w-4 shrink-0 text-black/45" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" /></svg>
                    <span className="truncate text-sm font-medium text-black/60">开发者模式</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={developerMode}
                    title={developerMode ? '关闭开发者模式' : '开启开发者模式'}
                    onClick={() => {
                      if (developerMode) {
                        setDeveloperMode(false);
                        try { localStorage.setItem('developer_mode', '0'); } catch { /* ignore */ }
                        // If currently viewing a template-resource panel, fall back to chat.
                        if (['skills', 'files', 'environments', 'vaults'].includes(activePanel)) {
                          setActivePanel('chat');
                        }
                      } else {
                        setShowDevModeConfirm(true);
                      }
                    }}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${developerMode ? 'bg-[#3550FF]' : 'bg-black/15'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${developerMode ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              </div>

              {/* User info at bottom */}
              <div className="mt-3 shrink-0 border-t border-[#EEF0F6] pt-3">
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition hover:bg-black/4"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#3550FF] to-[#7A5FF5] text-[11px] font-bold text-white">
                      {displayName.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-black/70">{displayName}</span>
                  </button>
                  {showUserMenu && (
                    <div className="absolute bottom-full left-0 z-50 mb-2 w-full rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
                      <button
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-black/70 transition hover:bg-gray-50"
                      >
                        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.2 48.2 0 0 0 5.496-.519c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
                        用户反馈
                      </button>
                      <button
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-black/70 transition hover:bg-gray-50"
                      >
                        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>
                        Forward 交流群
                      </button>
                      <button
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-black/70 transition hover:bg-gray-50"
                      >
                        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" /></svg>
                        帮助中心
                      </button>
                      <div className="mx-3 my-1 h-px bg-gray-100" />
                      <button
                        onClick={() => { setShowUserMenu(false); logout(); }}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-black/70 transition hover:bg-gray-50"
                      >
                        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" /></svg>
                        退出登录
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </section>
        </aside>
        )}

        <section className="relative min-w-0 flex-1 bg-white">
          {/* Expand sidebar button when collapsed */}
          {sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="absolute left-4 top-4 z-20 flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-black/50 shadow-sm transition hover:bg-gray-50 hover:text-black"
              title="展开侧边栏"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
          )}
          {/* Template switcher moved into the conversation list header */}

          {error && (
            <div className="absolute left-6 right-6 top-4 z-20 rounded-2xl border border-[#fecaca] bg-[#fef2f2] px-5 py-3 text-sm text-[#b42318] shadow-sm">
              {error}
            </div>
          )}

          {activePanel === 'schedules' ? (
  <div className="h-full overflow-y-auto bg-[#FAFBFF]">
    <div className="flex max-w-[1440px] flex-col gap-4 p-6">
      <div className="flex flex-col gap-4 px-1">
        <h1 className="text-xl font-semibold text-black">定时任务</h1>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black/60">我的定时任务</span>
            <button onClick={() => void loadSchedules()} className="flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-white hover:shadow-sm" title="刷新">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.58m15.36 2A8 8 0 0 0 4.58 9m0 0H9m11 11v-5h-.58m0 0A8 8 0 0 1 4.06 13m15.36 2H15" /></svg>
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-black/40">{schedules.length} 个任务</span>
            <button
              onClick={() => { setEditingSchedule(null); setSchedName(''); setSchedDesc(''); setSchedMessage(''); setSchedTriggerType('manual'); setSchedExpression(''); setSchedTimezone('Asia/Shanghai'); setSchedTemplateId(templateId || templates[0]?.id || ''); setShowScheduleModal(true); }}
              disabled={!ctx || loading || templates.length === 0}
              className="rounded-full bg-[#3550FF] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
            >
              + 新建任务
            </button>
          </div>
        </div>
      </div>
      <div className="space-y-3">
        {schedules.map((sched) => {
          const tpl = templates.find((t) => t.id === sched.template_id);
          const triggerLabel = sched.trigger_policy.type === 'cron' ? `Cron: ${sched.trigger_policy.expression || ''}` : sched.trigger_policy.type === 'interval' ? `间隔: ${sched.trigger_policy.expression || ''}` : sched.trigger_policy.type === 'once' ? `一次性: ${sched.trigger_policy.expression || ''}` : '手动触发';
          const rawContent = sched.initial_events?.[0]?.content;
          const messageText = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent[0]?.text || '' : '';
          const nextRun = sched.trigger_policy.upcoming_runs_at?.[0];
          const nextRunLabel = nextRun ? new Date(nextRun).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
          const isArchived = !!sched.archived_at;
          return (
            <div key={sched.id} className={`rounded-2xl border bg-white p-5 transition hover:shadow-md ${isArchived ? 'border-gray-200 opacity-60' : 'border-[#DDE2F2]'}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-black">{sched.name}</h3>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      isArchived ? 'bg-gray-100 text-black/40' :
                      sched.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                    }`}>
                      {isArchived ? '已归档' : sched.status === 'active' ? '启用' : '已暂停'}
                    </span>
                  </div>
                  {sched.description && <p className="mt-1 text-xs text-black/45">{sched.description}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-black/40">
                    <span className="inline-flex items-center gap-1">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
                      {triggerLabel}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6Z" /></svg>
                      {tpl?.name || sched.template_id}
                    </span>
                    {nextRunLabel && (
                      <span className="inline-flex items-center gap-1 text-[#3550FF]">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
                        下次: {nextRunLabel}
                      </span>
                    )}
                  </div>
                  {messageText && (
                    <div className="mt-2 rounded-lg bg-[#F8F9FF] px-3 py-2 text-xs text-black/50 line-clamp-2">
                      💬 {messageText}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => void handleRunSchedule(sched)}
                    disabled={runningScheduleId === sched.id || isArchived || sched.status !== 'active'}
                    className="rounded-lg bg-[#3550FF] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
                    title={isArchived ? '已归档不可执行' : sched.status !== 'active' ? '已暂停不可执行' : '立即执行一次'}
                  >
                    {runningScheduleId === sched.id ? '执行中...' : '▶ 执行'}
                  </button>
                  <button
                    onClick={() => void handleTogglePause(sched)}
                    disabled={isArchived}
                    className="rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-black/60 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {sched.status === 'active' ? '暂停' : '恢复'}
                  </button>
                  <button
                    onClick={() => {
                      setEditingSchedule(sched);
                      setSchedName(sched.name);
                      setSchedDesc(sched.description || '');
                      setSchedTemplateId(sched.template_id);
                      setSchedTriggerType(sched.trigger_policy.type as 'cron' | 'once' | 'interval' | 'manual');
                      setSchedExpression(sched.trigger_policy.expression || '');
                      setSchedTimezone(sched.trigger_policy.timezone || 'Asia/Shanghai');
                      const editRawContent = sched.initial_events?.[0]?.content;
                      setSchedMessage(typeof editRawContent === 'string' ? editRawContent : Array.isArray(editRawContent) ? editRawContent[0]?.text || '' : '');
                      setShowScheduleModal(true);
                    }}
                    disabled={isArchived}
                    className="rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-black/60 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    编辑
                  </button>
                  <button
                    disabled={isArchived}
                    onClick={() => { if (confirm(`确定删除定时任务「${sched.name}」吗？`)) void handleDeleteSchedule(sched.id); }}
                    className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-500 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {schedules.length === 0 && (
          <div className="rounded-2xl bg-white px-5 py-12 text-center shadow-[inset_0_0_0_1px_#2F3A801A]">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F4F6FC] text-2xl">⏰</div>
            <div className="text-sm font-medium text-black/60">暂无定时任务</div>
            <div className="mt-1 text-xs text-black/35">创建定时任务，让 AI 按计划自动执行</div>
            <button
              onClick={() => { setSchedTemplateId(templateId || templates[0]?.id || ''); setShowScheduleModal(true); }}
              disabled={templates.length === 0}
              className="mt-4 rounded-full bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
            >
              + 创建第一个定时任务
            </button>
          </div>
        )}
      </div>
    </div>
  </div>
) : activePanel === 'channels' ? (
  <div className="h-full overflow-y-auto bg-[#FAFBFF]">
    <div className="flex max-w-[1440px] flex-col gap-4 p-6">
      <div className="flex flex-col gap-4 px-1">
        <h1 className="text-xl font-semibold text-black">IM 渠道</h1>
        <div className="flex items-center justify-between">
          <p className="text-sm text-black/50">连接微信、钉钉、飞书等 IM 平台，让 AI 自动回复消息</p>
          <button
            onClick={() => { stopQrPolling(); setChanName(''); setChanType('wechat'); setChanMode('qr'); setChanTemplateId(templateId || templates[0]?.id || ''); setQrSession(null); setChannelStep('config'); setShowChannelModal(true); }}
            disabled={!ctx || loading || templates.length === 0}
            className="rounded-full bg-[#3550FF] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
          >
            + 添加渠道
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {channels.map((chan) => {
          const chanInfo = CHANNEL_TYPES.find((c) => c.value === chan.channel_type);
          const tpl = templates.find((t) => t.id === chan.template_id);
          // 只有 enabled=true 且 binding_status=bound 时渠道才真正处理上行消息
          const chanStatusLabel = chan.binding_status !== 'bound' ? (chan.binding_status === 'expired' ? '已过期' : '未绑定') : chan.enabled ? '生效中' : '已停用';
          const chanStatusCls = chan.binding_status !== 'bound'
            ? (chan.binding_status === 'expired' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-black/40')
            : chan.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-black/40';
          return (
            <div key={chan.id} className="rounded-2xl border border-[#DDE2F2] bg-white p-5 transition hover:shadow-md">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F4F6FC] text-xl">{chanInfo?.icon || '💬'}</span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-black">{chan.name || chanInfo?.label || chan.channel_type}</div>
                    <div className="text-xs text-black/40">{chanInfo?.label || chan.channel_type}</div>
                  </div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${chanStatusCls}`}>{chanStatusLabel}</span>
              </div>
              <div className="mt-3 flex items-center gap-3 text-xs text-black/40">
                <span className="inline-flex items-center gap-1">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6Z" /></svg>
                  {tpl?.name || chan.template_id.slice(0, 12) + '…'}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  onClick={() => { stopQrPolling(); setQrSession(null); setChanAppKey(''); setChanAppSecret(''); setChanAgentId(''); setChanMode(chan.binding_status === 'bound' ? 'qr' : 'qr'); setEditingChannelItem({ ...chan }); }}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-black/30 transition hover:bg-[#F4F6FC] hover:text-[#3550FF]"
                  title="配置"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                </button>
                <button
                  onClick={() => setDeleteChannelId(chan.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-black/30 transition hover:bg-red-50 hover:text-red-500"
                  title="删除"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                </button>
              </div>
            </div>
          );
        })}
        {channels.length === 0 && (
          <div className="col-span-full rounded-2xl bg-white px-5 py-12 text-center shadow-[inset_0_0_0_1px_#2F3A801A]">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F4F6FC] text-2xl">💬</div>
            <div className="text-sm font-medium text-black/60">暂无 IM 渠道</div>
            <div className="mt-1 text-xs text-black/35">连接微信、钉钉、飞书等平台，让 AI 自动回复用户消息</div>
            <button
              onClick={() => { stopQrPolling(); setChanName(''); setChanType('wechat'); setChanMode('qr'); setChanTemplateId(templateId || templates[0]?.id || ''); setQrSession(null); setCreatedChannelId(null); setChannelStep('config'); setChanAppKey(''); setChanAppSecret(''); setChanAgentId(''); setShowChannelModal(true); }}
              disabled={templates.length === 0}
              className="mt-4 rounded-full bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
            >
              + 添加第一个渠道
            </button>
          </div>
        )}
      </div>
    </div>
  </div>
) : activePanel === 'templates' ? (
            <div className="h-full overflow-y-auto bg-[#FAFBFF]">
              <div className="flex max-w-[1440px] flex-col gap-4 p-6">
                <div className="flex flex-col gap-4 px-1">
                  <h1 className="text-xl font-semibold text-black">我的模板</h1>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-black/60">我的模板</span>
                      <button
                        onClick={() => ctx && void listTemplates(ctx).then((page) => setTemplates(page.data)).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-white hover:shadow-sm"
                        aria-label="刷新模板列表"
                        title="刷新模板列表"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.58m15.36 2A8 8 0 0 0 4.58 9m0 0H9m11 11v-5h-.58m0 0A8 8 0 0 1 4.06 13m15.36 2H15" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-black/40">{templates.length} 个模板</span>
                      {developerMode && (
                        <button
                          onClick={openTemplateModal}
                          disabled={!ctx || loading}
                          className="rounded-full bg-[#3550FF] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
                        >
                          + 新建模板
                        </button>
                      )}
                    </div>
                  </div>
                </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {templates.map((template) => {
                  const isActive = templateId === template.id;
                  const tools = extractToolNames(template.tools);
                  const mcpNames = extractMcpNames(template.mcp_servers);
                  const skillsInfo = extractSkillInfo(template.skills);
                  const files = fileCount(template.files);
                  return (
                    <button
                      key={template.id}
                      onClick={() => {
                        setViewingTemplate(template);
                        void loadResources('environment', false);
                        void loadResources('skill', false);
                      }}
                      className={`group rounded-2xl border bg-white p-5 text-left transition hover:shadow-md ${
                        isActive ? 'border-[#3550FF] ring-1 ring-[#3550FF]/10' : 'border-[#DDE2F2] hover:border-[#B8C3FF]'
                      }`}
                    >
                      {/* Header: name + active badge */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[15px] font-semibold text-black">{template.name || '未命名模板'}</div>
                          {template.description && (
                            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-black/50">{template.description}</div>
                          )}
                        </div>
                        {isActive && (
                          <span className="shrink-0 rounded-full bg-[#3550FF]/8 px-2.5 py-0.5 text-[11px] font-medium text-[#3550FF]">
                            使用中
                          </span>
                        )}
                      </div>

                      {/* Config summary row */}
                      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-black/50">
                        <span className="inline-flex items-center gap-1">
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" /></svg>
                          {getModelLabel(template.model)}
                        </span>
                        {skillsInfo.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" /></svg>
                            {skillsInfo.length} 个技能
                          </span>
                        )}
                        {tools.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="m14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-5.9 5.9a2.1 2.1 0 1 1-3-3l5.9-5.9a5 5 0 0 1 6.4-6.4l-3 3 3 3Z" /></svg>
                            {tools.length} 个工具
                          </span>
                        )}
                        {mcpNames.length > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0h.375a2.625 2.625 0 0 1 0 5.25H17.25m-13.5 0V15" /></svg>
                            {mcpNames.length} 个 MCP 服务
                          </span>
                        )}
                        {files > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>
                            {files} 个文件
                          </span>
                        )}
                      </div>

                      {/* Tool badges */}
                      {tools.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {tools.slice(0, 6).map((name) => (
                            <span key={name} className="rounded-md bg-[#F4F6FC] px-2 py-0.5 text-[11px] text-black/45">
                              {name}
                            </span>
                          ))}
                          {tools.length > 6 && (
                            <span className="rounded-md bg-[#F4F6FC] px-2 py-0.5 text-[11px] text-black/35">
                              +{tools.length - 6}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
                {templates.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-[#DDE2F2] bg-white px-5 py-12 text-center">
                    <div className="text-sm text-black/40">暂无模板</div>
                    {developerMode && (
                      <button onClick={openTemplateModal} className="mt-4 rounded-full bg-[#EDEEF6] px-4 py-2 text-xs font-medium text-black hover:bg-[#E3E6F3]">
                        新建第一个模板
                      </button>
                    )}
                  </div>
                )}
              </div>
              </div>
            </div>
          ) : activePanel === 'memoryStores' ? (
            <div className="h-full overflow-y-auto bg-[#FAFBFF]">
              <div className="flex max-w-[1440px] flex-col gap-5 p-6">
                <div className="flex items-baseline justify-between">
                  <h1 className="text-lg font-medium text-black">记忆</h1>
                  <span className="font-mono text-xs text-black/40">{displayName}</span>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2">
                    <span className="text-xs font-medium text-black/50">模板:</span>
                    <select
                      value={memoryTemplateId}
                      onChange={(e) => { setMemoryTemplateId(e.target.value); void loadMemoryEntriesForTemplate(e.target.value); }}
                      className="h-9 rounded-lg border border-[#E5E7EB] bg-white px-3 text-sm outline-none focus:border-[#3550FF]"
                    >
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name || t.id}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    onClick={() => void loadMemoryEntriesForTemplate(memoryTemplateId)}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-white hover:shadow-sm"
                    aria-label="刷新记忆列表"
                    title="刷新记忆列表"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.58m15.36 2A8 8 0 0 0 4.58 9m0 0H9m11 11v-5h-.58m0 0A8 8 0 0 1 4.06 13m15.36 2H15" />
                    </svg>
                  </button>
                  <span className="ml-auto flex items-center gap-3 text-sm text-black/40">
                    {memoryStoreId && (
                      <span className="font-mono text-xs text-black/35" title="当前读取的记忆库 ID">{memoryStoreId}</span>
                    )}
                    <span>{memoryEntries.length} 条记忆</span>
                  </span>
                </div>
                <div className="rounded-2xl border border-[#DDE2F2] bg-white p-5">
                  {memoryEntries.length === 0 ? (
                    <div className="py-12 text-center">
                      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F4F6FC] text-2xl">🧠</div>
                      <div className="text-sm font-medium text-black/60">暂无记忆</div>
                      <div className="mt-1 text-xs text-black/35">当前模板下还没有记忆内容</div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {memoryEntries.map((entry) => (
                        <div key={entry.id} className="rounded-xl border border-[#E5E7EB] p-4 transition hover:border-[#B8C3FF]">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-black">{entry.path}</span>
                                <span className="shrink-0 rounded-full bg-[#EDEEF6] px-1.5 py-0.5 text-[10px] text-black/40">v{entry.version}</span>
                              </div>
                              {entry.content && (
                                <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-[#FAFBFF] p-3 text-xs text-black/60">
                                  <pre className="whitespace-pre-wrap font-mono">{entry.content}</pre>
                                </div>
                              )}
                              <div className="mt-2 flex items-center gap-3 text-[11px] text-black/35">
                                <span>{formatBytes(entry.size)}</span>
                                {entry.updated_at && <span>更新于 {relativeTime(entry.updated_at)}</span>}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : isResourcePanel(activePanel) || activePanel === 'usage' ? (
            <div className="h-full overflow-y-auto bg-[#FAFBFF]">
              <div className="flex max-w-[1440px] flex-col gap-5 p-6">
                <div className="flex items-baseline justify-between">
                  <h1 className="text-lg font-medium text-black">
                    {activePanel === 'usage' ? '我的用量' : `${activeResourceLabel}空间`}
                  </h1>
                  <span className="font-mono text-xs text-black/40">{displayName}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-black/60">
                      {activePanel === 'usage' ? '当前统计' : `${activeResourceLabel}列表`}
                    </span>
                    {activePanel !== 'usage' && (
                      <button
                        onClick={() => void loadResources(activeResourceType)}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-white hover:shadow-sm"
                        aria-label={`刷新${activeResourceLabel}列表`}
                        title={`刷新${activeResourceLabel}列表`}
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.58m15.36 2A8 8 0 0 0 4.58 9m0 0H9m11 11v-5h-.58m0 0A8 8 0 0 1 4.06 13m15.36 2H15" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-black/40">
                      {activePanel === 'usage' ? '本地 quickstart 概览' : `${resources.length} 个${activeResourceLabel}`}
                    </span>
                    {activePanel !== 'usage' && (
                      <>
                        <button
                          onClick={() => setShowCreateResourceModal(true)}
                          disabled={!ctx || loading}
                          className="rounded-full bg-[#3550FF] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
                        >
                          + 创建{activeResourceLabel}
                        </button>
                        <button
                          onClick={() => setShowResourceModal(true)}
                          disabled={!ctx || loading}
                          className="rounded-full border border-[#DDE2F2] bg-white px-3 py-2 text-xs font-medium text-black/55 transition hover:bg-gray-50 disabled:opacity-50"
                          title="注册一个已有的资源 ID"
                        >
                          注册已有
                        </button>
                      </>
                    )}
                  </div>
                </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {(activePanel === 'usage' ? [] : resources).map((resource) => {
                  const subtitle = resourceSubtitle(resource);
                  const resName = resource.name || specString(resource, 'display_title', 'display_name', 'filename', 'name') || resource.id;
                  const version = specNumber(resource, 'latest_version', 'version');
                  const source = specString(resource, 'source');
                  const createdAt = specString(resource, 'created_at') || '';
                  return (
                    <button
                      key={`${resource.type}-${resource.id}-main`}
                      onClick={() => setViewingResource(resource)}
                      className="group rounded-2xl border border-[#DDE2F2] bg-white p-5 text-left transition hover:border-[#B8C3FF] hover:shadow-md"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F4F6FC] text-lg">
                          {RESOURCE_ICONS[resource.type]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <div className="truncate text-sm font-semibold text-black">{resName}</div>
                            {version != null && (
                              <span className="shrink-0 rounded-full bg-[#EDEEF6] px-1.5 py-0.5 text-[10px] text-black/40">v{version}</span>
                            )}
                          </div>
                          <div className="mt-1 truncate text-xs text-black/45">{subtitle}</div>
                        </div>
                      </div>
                      {/* Type-specific meta row */}
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-black/35">
                        {source && <span>{source === 'custom' ? '自定义' : source === 'qoder' ? '官方' : source}</span>}
                        {resource.type === 'file' && specString(resource, 'mime_type') && (
                          <span>{specString(resource, 'mime_type')}</span>
                        )}
                        {createdAt && <span>{relativeTime(createdAt)}</span>}
                        <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-600">
                          {resource.status || '已注册'}
                        </span>
                      </div>
                    </button>
                  );
                })}
                {activePanel !== 'usage' && resources.length === 0 && (
                  <div className="rounded-2xl bg-white px-5 py-12 text-center shadow-[inset_0_0_0_1px_#2F3A801A]">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F4F6FC] text-2xl">
                      {RESOURCE_ICONS[activeResourceType]}
                    </div>
                    <div className="text-sm font-medium text-black/60">暂无{activeResourceLabel}</div>
                    <div className="mt-1 text-xs text-black/35">创建一个新的{activeResourceLabel}开始使用</div>
                    <div className="mt-4 flex justify-center gap-2">
                      <button
                        onClick={() => setShowCreateResourceModal(true)}
                        className="rounded-full bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0]"
                      >
                        + 创建{activeResourceLabel}
                      </button>
                      <button
                        onClick={() => setShowResourceModal(true)}
                        className="rounded-full border border-[#DDE2F2] bg-white px-4 py-2 text-xs font-medium text-black/60 transition hover:bg-gray-50"
                      >
                        注册已有
                      </button>
                    </div>
                  </div>
                )}
                {activePanel === 'usage' && (
                  <>
                    <div className="rounded-2xl bg-white p-5 shadow-[inset_0_0_0_1px_#2F3A801A]">
                      <div className="text-xs text-black/45">模板数量</div>
                      <div className="mt-4 text-3xl font-semibold">{templates.length}</div>
                    </div>
                    <div className="rounded-2xl bg-white p-5 shadow-[inset_0_0_0_1px_#2F3A801A]">
                      <div className="text-xs text-black/45">会话数量</div>
                      <div className="mt-4 text-3xl font-semibold">{sessions.length}</div>
                    </div>
                  </>
                )}
              </div>
              {activePanel === 'usage' && (
                <div className="rounded-2xl bg-white p-5 shadow-[inset_0_0_0_1px_#2F3A801A]">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-black">Session 列表</h2>
                      <p className="mt-1 text-xs text-black/40">展示当前身份与模板下的会话开始、结束时间和状态</p>
                    </div>
                    <button
                      onClick={() => void refreshSessions(identity, templateId)}
                      disabled={!ctx || loading}
                      className="rounded-full border border-[#D9DCEA] bg-white px-4 py-2 text-xs font-medium text-black/65 transition hover:bg-[#F8F9FC] disabled:opacity-45"
                    >
                      刷新列表
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-[960px] w-full border-separate border-spacing-0 text-left text-sm">
                      <thead>
                        <tr className="text-xs text-black/40">
                          <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">Session</th>
                          <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">开始时间</th>
                          <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">结束时间</th>
                          <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">状态</th>
                          <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">时长</th>
                          <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">Template</th>
                          <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">最近更新</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sessions.map((session) => {
                          const endTime = sessionEndTime(session);
                          return (
                            <tr key={`usage-${session.id}`} className="text-xs text-black/65">
                              <td className="max-w-[260px] border-b border-[#F2F4FA] px-3 py-3">
                                <div className="truncate font-medium text-black" title={session.title || session.id}>
                                  {session.title || 'Forward 会话'}
                                </div>
                                <div className="mt-1 truncate font-mono text-[11px] text-black/35" title={session.id}>
                                  {session.id}
                                </div>
                              </td>
                              <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3 font-mono text-[11px]">
                                {displayDateTime(session.created_at)}
                              </td>
                              <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3 font-mono text-[11px]">
                                {displayDateTime(endTime)}
                              </td>
                              <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3">
                                <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium ${sessionStatusBadgeClass(session.status)}`}>
                                  {sessionStatusLabel(session.status)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3 font-mono text-[11px]">
                                {sessionDuration(session)}
                              </td>
                              <td className="max-w-[180px] border-b border-[#F2F4FA] px-3 py-3">
                                <span className="block truncate font-mono text-[11px] text-black/45" title={session.template_id}>
                                  {session.template?.name || session.template_id || '—'}
                                </span>
                              </td>
                              <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3 font-mono text-[11px]">
                                {displayDateTime(session.updated_at)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {sessions.length === 0 && (
                      <div className="px-4 py-12 text-center text-sm text-black/35">暂无 Session</div>
                    )}
                  </div>
                </div>
              )}
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-row overflow-hidden">
              {/* ── Conversation list ── */}
              <div className="flex w-[300px] shrink-0 flex-col border-r border-gray-100 bg-[#FAFBFF]">
                {/* Header: template switcher (replaces the "对话" title) */}
                <div className="flex items-center justify-between gap-2 px-5 pb-3 pt-5">
                  <div className="relative min-w-0 flex-1" ref={templateSwitcherRef}>
                    <button
                      onClick={() => setShowTemplateSwitcher(!showTemplateSwitcher)}
                      className="-ml-2 flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-base font-semibold text-black transition hover:bg-gray-100"
                    >
                      <span className="truncate">{currentTemplate?.name || '选择模板'}</span>
                      <svg className={`h-4 w-4 shrink-0 text-black/40 transition ${showTemplateSwitcher ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" /></svg>
                    </button>
                    {showTemplateSwitcher && (
                      <div className="absolute left-0 top-full z-50 mt-1 w-[280px] rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg">
                        <div className="max-h-72 overflow-y-auto">
                          {templates.length === 0 && (
                            <div className="py-3 text-center text-xs text-black/35">暂无模板</div>
                          )}
                          {templates.map((template) => {
                            const isSelected = templateId === template.id;
                            const skillCount = extractSkillInfo(template.skills).length;
                            return (
                              <button
                                key={template.id}
                                onClick={() => {
                                  // Abort any running SSE stream from the previous template
                                  // so its background polling stops calling refreshSessions
                                  // and streaming state is cleared for the new template.
                                  streamAbort.current?.abort();
                                  setStreaming(false);
                                  setTemplateId(template.id);
                                  currentSessionIdRef.current = '';
                                  setCurrentSessionId('');
                                  setEvents([]);
                                  setSessionLoading(false);
                                  setShowTemplateSwitcher(false);
                                  void refreshSessions(identity, template.id);
                                }}
                                className={`w-full rounded-lg px-3 py-2.5 text-left transition ${
                                  isSelected ? 'bg-[#F4F6FC]' : 'hover:bg-gray-50'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="truncate text-sm font-medium text-black/80">{template.name || '未命名模板'}</div>
                                  {isSelected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#3550FF]" />}
                                </div>
                                {template.description && (
                                  <div className="mt-0.5 truncate text-[11px] text-black/40">{template.description}</div>
                                )}
                                <div className="mt-1 flex items-center gap-2 text-[11px] text-black/35">
                                  <span>{getModelLabel(template.model)}</span>
                                  {skillCount > 0 && <span>· {skillCount} 个技能</span>}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        <div className="border-t border-gray-100 p-1.5">
                          {developerMode ? (
                          <button
                            onClick={() => { setShowTemplateSwitcher(false); openTemplateModal(); }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-[#3550FF] transition hover:bg-[#F4F6FC]"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                            新建模板
                          </button>
                          ) : (
                          <button
                            onClick={() => { setShowTemplateSwitcher(false); setActivePanel('templates'); }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-black/50 transition hover:bg-gray-50"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" /></svg>
                            查看全部模板
                          </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => { currentSessionIdRef.current = ''; setCurrentSessionId(''); setEvents([]); setSessionLoading(false); }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-black/45 transition hover:bg-gray-100 hover:text-black"
                    title="新建对话"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                    </svg>
                  </button>
                </div>

                {/* Search */}
                <div className="px-4 pb-3">
                  <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 transition focus-within:border-[#B8C3FF]">
                    <svg className="h-3.5 w-3.5 shrink-0 text-black/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                    </svg>
                    <input
                      value={conversationSearch}
                      onChange={(e) => setConversationSearch(e.target.value)}
                      placeholder="搜索对话..."
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-black/30"
                    />
                  </div>
                </div>

                {/* Session list */}
                <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
                  {(() => {
                    const searchQuery = conversationSearch.trim().toLowerCase();
                    const filtered = searchQuery
                      ? sessions.filter((s) => (s.title || '').toLowerCase().includes(searchQuery) || s.id.toLowerCase().includes(searchQuery))
                      : sessions;
                    // Pinned sessions surface in their own group above the date groups,
                    // ordered by pin recency (most recently pinned first).
                    const pinnedItems = pinnedSessionIds
                      .map((id) => filtered.find((s) => s.id === id))
                      .filter((s): s is ForwardSession => Boolean(s));
                    const rest = filtered.filter((s) => !pinnedSessionIds.includes(s.id));
                    const groups = [
                      ...(pinnedItems.length > 0 ? [{ label: '置顶', items: pinnedItems }] : []),
                      ...(searchQuery ? [{ label: '', items: rest }] : groupSessionsByDate(rest)),
                    ];

                    if (filtered.length === 0) {
                      return (
                        <div className="py-12 text-center">
                          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-gray-100">
                            <svg className="h-5 w-5 text-black/25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
                            </svg>
                          </div>
                          <div className="text-sm text-black/35">{searchQuery ? '未找到匹配的对话' : '暂无对话'}</div>
                          {!searchQuery && (
                            <div className="mt-1 text-xs text-black/25">发送消息开始新对话</div>
                          )}
                        </div>
                      );
                    }

                    return groups.map((group) => (
                      <div key={group.label} className="mb-1">
                        {group.label && (
                          <div className="px-2.5 py-2 text-[11px] font-medium text-black/35">{group.label}</div>
                        )}
                        {group.items.map((session) => {
                          const isPinned = pinnedSessionIds.includes(session.id);
                          return (
                            <div
                              key={session.id}
                              role="button"
                              tabIndex={0}
                              onClick={() => void selectSession(session.id)}
                              onKeyDown={(e) => { if (e.key === 'Enter') void selectSession(session.id); }}
                              className={`group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition ${
                                currentSessionId === session.id
                                  ? 'bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)]'
                                  : 'hover:bg-white/60'
                              }`}
                            >
                              {isSessionOngoing(session.status) && (
                                <span className="relative flex h-2 w-2 shrink-0">
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                                </span>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className={`truncate text-[13px] ${currentSessionId === session.id ? 'font-medium text-black' : 'text-black/70'}`}>
                                  {session.title || 'Forward 会话'}
                                </div>
                                <div className="mt-0.5 text-[11px] text-black/30">{relativeTime(session.created_at)}</div>
                              </div>
                              {/* Pin toggle: hidden until hover for unpinned rows, always visible when pinned */}
                              <button
                                type="button"
                                title={isPinned ? '取消置顶' : '置顶'}
                                onClick={(e) => { e.stopPropagation(); togglePinSession(session.id); }}
                                className={`shrink-0 rounded-md p-1 transition ${
                                  isPinned
                                    ? 'text-[#3550FF] hover:bg-black/5'
                                    : 'text-black/30 opacity-0 hover:bg-black/5 hover:text-black/60 group-hover:opacity-100'
                                }`}
                              >
                                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M16 4v7l2 3v2H6v-2l2-3V4h8Z" />
                                  <path d="M12 16v5" />
                                </svg>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ));
                  })()}
                </div>
              </div>

              {/* ── Chat content area ── */}
              <div className="flex min-w-0 flex-1 flex-col bg-white">
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  accept={ATTACHMENT_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    pickAttachments(e.target.files);
                    e.target.value = '';
                  }}
                />
                {events.length === 0 && sessionLoading && (
                  <div className="flex min-h-0 flex-1 items-center justify-center">
                    <svg className="h-7 w-7 animate-spin text-[#3550FF]" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2Z" />
                    </svg>
                  </div>
                )}
                {events.length === 0 && !sessionLoading && (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-12 pt-4">
                    <div className="w-full max-w-[680px]">
                      <div className="mb-8 text-center">
                        <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[#3550FF]/6 text-[#3550FF]">
                          <BrandIcon className="h-6 w-6" rounded="rounded-lg" />
                        </div>
                        <h1 className="text-2xl font-semibold text-black">
                          {currentTemplate ? `和 ${currentTemplate.name} 开始对话` : '开始新对话'}
                        </h1>
                        <p className="mt-2 text-sm text-black/40">
                          {currentTemplate ? `当前使用 ${getModelLabel(currentTemplate.model)} 模型` : '请先选择一个模板，然后输入你的问题'}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-[#E5E7EB] bg-white px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition focus-within:border-[#3550FF] focus-within:shadow-[0_0_0_3px_rgba(53,80,255,0.06)]">
                        <AttachmentChips attachments={attachments} onRemove={removeAttachment} onRetry={retryAttachment} />
                        <textarea
                          ref={inputRef}
                          value={input}
                          onChange={(event) => setInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              void send();
                            }
                          }}
                          placeholder={templateId ? '输入你的问题... (Enter 发送)' : '请先选择模板'}
                          disabled={!templateId}
                          className="min-h-[44px] max-h-[140px] w-full resize-none bg-transparent text-[15px] leading-6 outline-none placeholder:text-black/30 disabled:cursor-not-allowed"
                          rows={1}
                        />
                        <div className="mt-2 flex items-center justify-between">
                          <div className="flex items-center gap-1 text-[11px] text-black/30">
                            <span className="rounded border border-black/10 px-1 py-px font-mono text-[10px]">Enter</span>
                            <span>发送</span>
                            <span className="mx-1">·</span>
                            <span className="rounded border border-black/10 px-1 py-px font-mono text-[10px]">Shift+Enter</span>
                            <span>换行</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              title="添加附件（文本类文件，单个 ≤5MB）"
                              onClick={() => attachmentInputRef.current?.click()}
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-black/40 transition hover:bg-black/5 hover:text-black/70"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32a1.5 1.5 0 0 1-2.122-2.122l7.693-7.693" />
                              </svg>
                            </button>
                            <ChatSettingsButton
                              showThinking={showThinking}
                              showToolCalls={showToolCalls}
                              onToggleThinking={toggleShowThinking}
                              onToggleToolCalls={toggleShowToolCalls}
                            />
                            <button
                              onClick={() => void send()}
                              disabled={!canSendMessage}
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
                                canSendMessage
                                  ? 'bg-[#3550FF] text-white hover:bg-[#2a42e0]'
                                  : 'bg-[#F3F4F6] text-black/20'
                              }`}
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" /></svg>
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="mt-6 grid grid-cols-2 gap-2.5">
                        {[
                          { icon: '💡', text: '你能做些什么？', desc: '了解我的能力' },
                          { icon: '🔥', text: '帮我查一下现在全网最火的3个热点', desc: '实时热点追踪' },
                          { icon: '📊', text: '用简洁的语言解释量子计算', desc: '知识科普' },
                          { icon: '✍️', text: '帮我写一封专业的商务合作邮件', desc: '文案创作' },
                        ].map((item) => (
                          <button
                            key={item.text}
                            onClick={() => void sendQuick(item.text)}
                            disabled={!templateId}
                            className="flex items-start gap-3 rounded-xl border border-[#E5E7EB] bg-white px-4 py-3 text-left transition hover:border-[#B8C3FF] hover:bg-[#FAFBFF] disabled:opacity-40"
                          >
                            <span className="mt-0.5 text-base">{item.icon}</span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm text-black/75">{item.text}</div>
                              <div className="mt-0.5 text-[11px] text-black/35">{item.desc}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {events.length > 0 && (
                  <div ref={chatScrollRef} onScroll={handleChatScroll} className="min-h-0 flex-1 overflow-y-auto px-8">
                    <div className="mx-auto flex max-w-[860px] flex-col py-6">
                    <div className="space-y-4 pb-8">
                      {events.map((event, index) => {
                        const kind = eventViewKind(event);
                        if (kind === 'hidden') return null;
                        if (kind === 'agent_thinking') {
                          if (!showThinking) return null;
                          return <ThinkingMessage key={event.id} event={event} />;
                        }
                        if (kind === 'tool_use') {
                          if (!showToolCalls) return null;
                          return (
                            <ToolEventMessage
                              key={event.id}
                              event={event}
                              result={false}
                              pending={isToolUsePending(events, event, index)}
                            />
                          );
                        }
                        if (kind === 'tool_result') {
                          if (!showToolCalls) return null;
                          return (
                            <ToolEventMessage
                              key={event.id}
                              event={event}
                              result
                              displayName={toolDisplayNameForEvent(events, event, index)}
                              ctx={ctx}
                            />
                          );
                        }
                        if (kind === 'session_error') return <SessionErrorMessage key={event.id} event={event} />;
                        if (kind === 'multiagent_status') {
                          const info = multiagentEventInfo(event);
                          if (!info) return null;
                          return (
                            <div key={event.id} className="flex items-center justify-center py-1">
                              <span className="rounded-full bg-[#F4F6FC] px-3 py-1 text-[11px] text-black/40">{info}</span>
                            </div>
                          );
                        }
                        if (kind === 'user') return <ChatTextMessage key={event.id} event={event} user />;
                        return <ChatTextMessage key={event.id} event={event} />;
                      })}
                    </div>
                    </div>
                  </div>
                )}
                {events.length > 0 && (
                  <div className="shrink-0 px-8 pb-6 pt-2">
                    <div className="mx-auto max-w-[860px]">
                      <div className="rounded-2xl border border-[#E5E7EB] bg-white px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition focus-within:border-[#3550FF] focus-within:shadow-[0_0_0_3px_rgba(53,80,255,0.06)]">
                        <AttachmentChips attachments={attachments} onRemove={removeAttachment} onRetry={retryAttachment} />
                        <textarea
                          value={input}
                          onChange={(event) => setInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              if (canStopCurrentTurn || stopping) return; // block send while streaming
                              void send();
                            }
                          }}
                          placeholder={canStopCurrentTurn ? 'Agent 正在回复中，请稍候...' : '继续对话... (Enter 发送)'}
                          className="min-h-[24px] max-h-[140px] w-full resize-none bg-transparent text-[15px] leading-6 outline-none placeholder:text-black/30"
                          rows={1}
                        />
                        <div className="mt-2 flex items-center justify-between">
                          <div className="flex items-center gap-1 text-[11px] text-black/30">
                            <span className="rounded border border-black/10 px-1 py-px font-mono text-[10px]">Enter</span>
                            <span>发送</span>
                            <span className="mx-1">·</span>
                            <span className="rounded border border-black/10 px-1 py-px font-mono text-[10px]">Shift+Enter</span>
                            <span>换行</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              title="添加附件（文本类文件，单个 ≤5MB）"
                              onClick={() => attachmentInputRef.current?.click()}
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-black/40 transition hover:bg-black/5 hover:text-black/70"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32a1.5 1.5 0 0 1-2.122-2.122l7.693-7.693" />
                              </svg>
                            </button>
                            <ChatSettingsButton
                              showThinking={showThinking}
                              showToolCalls={showToolCalls}
                              onToggleThinking={toggleShowThinking}
                              onToggleToolCalls={toggleShowToolCalls}
                            />
                            <button
                              onClick={() => ((canStopCurrentTurn || stopping) ? void stop() : void send())}
                              disabled={!(canStopCurrentTurn || stopping) && !canSendMessage}
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
                                (canStopCurrentTurn || stopping)
                                  ? 'bg-red-500 text-white hover:bg-red-600'
                                  : canSendMessage
                                    ? 'bg-[#3550FF] text-white hover:bg-[#2a42e0]'
                                    : 'bg-[#F3F4F6] text-black/20'
                              }`}
                            >
                              {(canStopCurrentTurn || stopping) ? (
                                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                              ) : (
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" /></svg>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
        </main>
      </div>

      {/* Resource detail modal */}
      {viewingResource && (() => {
        const vr = viewingResource;
        const vrName = vr.name || specString(vr, 'display_name', 'filename', 'name') || vr.id;
        const vrDesc = vr.description || specString(vr, 'description');
        const vrVersion = specNumber(vr, 'latest_version', 'version');
        const vrCreatedAt = specString(vr, 'created_at');
        return (
          <Modal open onClose={() => setViewingResource(null)} title={`${RESOURCE_TYPE_LABELS[vr.type]}详情`}>
            {/* Header */}
            <div className="mb-5 flex items-start gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#F4F6FC] text-xl">
                {RESOURCE_ICONS[vr.type]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-black">{vrName}</h3>
                  {vrVersion != null && (
                    <span className="shrink-0 rounded-full bg-[#EDEEF6] px-2 py-0.5 text-[11px] text-black/40">v{vrVersion}</span>
                  )}
                </div>
                {vrDesc && <p className="mt-1 text-sm text-black/50">{vrDesc}</p>}
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="font-mono text-[11px] text-black/30">{vr.id}</span>
                  <button onClick={() => void navigator.clipboard.writeText(vr.id)} className="text-[11px] text-[#3550FF] hover:text-[#2a42e0]">复制</button>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {/* Type-specific details */}
              {vr.type === 'skill' && (
                <div className="rounded-xl border border-[#EEF1F7] bg-[#FAFBFF] p-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><div className="text-[11px] text-black/40">来源</div><div className="mt-0.5">{specString(vr, 'source') === 'custom' ? '自定义' : specString(vr, 'source') === 'qoder' ? '官方预置' : specString(vr, 'source') || '—'}</div></div>
                    <div><div className="text-[11px] text-black/40">版本</div><div className="mt-0.5">{vrVersion != null ? `v${vrVersion}` : '—'}</div></div>
                  </div>
                </div>
              )}
              {vr.type === 'file' && (
                <div className="rounded-xl border border-[#EEF1F7] bg-[#FAFBFF] p-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><div className="text-[11px] text-black/40">文件大小</div><div className="mt-0.5">{formatFileSize(specNumber(vr, 'size_bytes')) || '—'}</div></div>
                    <div><div className="text-[11px] text-black/40">文件类型</div><div className="mt-0.5">{specString(vr, 'mime_type') || '—'}</div></div>
                    {specString(vr, 'filename') && <div className="col-span-2"><div className="text-[11px] text-black/40">文件名</div><div className="mt-0.5 font-mono text-xs">{specString(vr, 'filename')}</div></div>}
                  </div>
                </div>
              )}
              {vr.type === 'environment' && (() => {
                const config = vr.resource_spec?.config as Record<string, unknown> | undefined;
                const networking = config?.networking as { type?: string } | undefined;
                const packages = config?.packages as { apt?: string[]; npm?: string[]; pip?: string[] } | undefined;
                const pkgCount = (packages?.apt?.length || 0) + (packages?.npm?.length || 0) + (packages?.pip?.length || 0);
                return (
                  <div className="rounded-xl border border-[#EEF1F7] bg-[#FAFBFF] p-4">
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div><div className="text-[11px] text-black/40">网络策略</div><div className="mt-0.5">{networking?.type === 'unrestricted' ? '完全开放' : '受限'}</div></div>
                      <div><div className="text-[11px] text-black/40">预装包</div><div className="mt-0.5">{pkgCount > 0 ? `${pkgCount} 个` : '无'}</div></div>
                    </div>
                    {typeof config?.setup_script === 'string' && config.setup_script && (
                      <div className="mt-3"><div className="text-[11px] text-black/40">初始化脚本</div><pre className="mt-1 max-h-[100px] overflow-auto rounded-lg bg-[#1e1e2e] px-3 py-2 font-mono text-[11px] text-[#cdd6f4]">{String(config.setup_script)}</pre></div>
                    )}
                  </div>
                );
              })()}
              {vr.type === 'vault' && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-[#EEF1F7] bg-[#FAFBFF] p-4">
                    <div className="text-sm">
                      <div className="text-[11px] text-black/40">凭据库说明</div>
                      <div className="mt-1 text-xs text-black/55">凭据库用于安全存储 API Token、密钥等敏感信息，可在模板中引用以自动注入 MCP 服务认证。</div>
                    </div>
                  </div>

                  {/* Credentials section */}
                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-xs font-semibold text-black/50">凭据列表</span>
                      <span className="text-[11px] text-black/35">{vaultCredentials.length} 个凭据</span>
                    </div>

                    {/* Existing credentials */}
                    {vaultCredentials.length > 0 && (
                      <div className="space-y-2">
                        {vaultCredentials.map((cred) => (
                          <div key={cred.id} className="flex items-center justify-between rounded-xl bg-[#F8F9FF] px-4 py-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-black/70">{cred.auth.mcp_server_url || cred.auth.secret_name || cred.id}</div>
                              <div className="mt-0.5 flex items-center gap-1.5">
                                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                                  cred.auth.type === 'static_bearer' ? 'bg-blue-100 text-blue-600' :
                                  cred.auth.type === 'mcp_oauth' ? 'bg-purple-100 text-purple-600' :
                                  'bg-amber-100 text-amber-600'
                                }`}>
                                  {cred.auth.type === 'static_bearer' ? 'Bearer' : cred.auth.type === 'mcp_oauth' ? 'OAuth' : 'Env'}
                                </span>
                                <span className="text-[10px] text-black/35">
                                  {cred.auth.type === 'static_bearer' ? 'Bearer Token' :
                                   cred.auth.type === 'mcp_oauth' ? 'OAuth Token' :
                                   '环境变量'}
                                </span>
                              </div>
                            </div>
                            <button
                              onClick={() => {
                                if (!ctx) return;
                                void deleteCloudCredential(ctx, vr.id, cred.id).then(() => {
                                  setVaultCredentials((prev) => prev.filter((c) => c.id !== cred.id));
                                }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                              }}
                              className="ml-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-red-400 transition hover:bg-red-50 hover:text-red-600"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.688 0 .346-9m-4.688 0L8.414 5.25a1.5 1.5 0 0 1 1.06-.44h3.172a1.5 1.5 0 0 1 1.06.44L15.25 9m-4.688 0L15.25 9m-4.688 0h4.688m-8.5 8.25h4.5m-4.5 0a2.25 2.25 0 0 1-2.25-2.25v-4.5a2.25 2.25 0 0 1 2.25-2.25h4.5a2.25 2.25 0 0 1 2.25 2.25v4.5a2.25 2.25 0 0 1-2.25 2.25" /></svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {vaultCredentials.length === 0 && (
                      <div className="rounded-xl bg-[#F8F9FF] px-4 py-4 text-center text-xs text-black/40">暂无凭据，请在下方添加</div>
                    )}

                    {/* Add new credential */}
                    <div className="mt-3 rounded-xl border border-dashed border-[#DDE2F2] p-4">
                      <div className="mb-3 text-xs font-medium text-black/50">添加新凭据</div>

                      {/* Credential type selector */}
                      <div className="mb-3 grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          onClick={() => setNewCredType('static_bearer')}
                          className={`rounded-lg py-2 text-[11px] font-medium transition ${newCredType === 'static_bearer' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                        >
                          Bearer Token
                        </button>
                        <button
                          type="button"
                          onClick={() => setNewCredType('mcp_oauth')}
                          className={`rounded-lg py-2 text-[11px] font-medium transition ${newCredType === 'mcp_oauth' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                        >
                          OAuth Token
                        </button>
                        <button
                          type="button"
                          onClick={() => setNewCredType('environment_variable')}
                          className={`rounded-lg py-2 text-[11px] font-medium transition ${newCredType === 'environment_variable' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                        >
                          环境变量
                        </button>
                      </div>

                      {/* static_bearer / mcp_oauth: MCP Server URL */}
                      {(newCredType === 'static_bearer' || newCredType === 'mcp_oauth') && (
                        <input
                          value={newCredUrl}
                          onChange={(e) => setNewCredUrl(e.target.value)}
                          placeholder="MCP Server URL（例如：https://api.example.com/mcp）"
                          className="mb-2 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                        />
                      )}

                      {/* static_bearer: token */}
                      {newCredType === 'static_bearer' && (
                        <input
                          value={newCredToken}
                          onChange={(e) => setNewCredToken(e.target.value)}
                          type="password"
                          placeholder="Bearer Token"
                          className="mb-3 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                        />
                      )}

                      {/* mcp_oauth: access_token + expires_at */}
                      {newCredType === 'mcp_oauth' && (
                        <>
                          <input
                            value={newCredAccessToken}
                            onChange={(e) => setNewCredAccessToken(e.target.value)}
                            type="password"
                            placeholder="OAuth Access Token"
                            className="mb-2 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                          />
                          <input
                            value={newCredExpiresAt}
                            onChange={(e) => setNewCredExpiresAt(e.target.value)}
                            type="datetime-local"
                            placeholder="过期时间（可选）"
                            className="mb-3 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                          />
                        </>
                      )}

                      {/* environment_variable: secret_name + secret_value */}
                      {newCredType === 'environment_variable' && (
                        <>
                          <input
                            value={newCredSecretName}
                            onChange={(e) => setNewCredSecretName(e.target.value)}
                            placeholder="环境变量名（例如：API_KEY）"
                            className="mb-2 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                          />
                          <input
                            value={newCredSecretValue}
                            onChange={(e) => setNewCredSecretValue(e.target.value)}
                            type="password"
                            placeholder="密钥值"
                            className="mb-3 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                          />
                        </>
                      )}

                      <button
                        onClick={() => {
                          if (!ctx) return;
                          let auth: Parameters<typeof createCloudCredential>[2];
                          if (newCredType === 'static_bearer') {
                            if (!newCredUrl.trim() || !newCredToken.trim()) return;
                            auth = { type: 'static_bearer', mcp_server_url: newCredUrl.trim(), token: newCredToken.trim() };
                          } else if (newCredType === 'mcp_oauth') {
                            if (!newCredUrl.trim() || !newCredAccessToken.trim()) return;
                            auth = { type: 'mcp_oauth', mcp_server_url: newCredUrl.trim(), access_token: newCredAccessToken.trim() };
                            if (newCredExpiresAt.trim()) auth.expires_at = newCredExpiresAt.trim();
                          } else {
                            if (!newCredSecretName.trim() || !newCredSecretValue.trim()) return;
                            auth = { type: 'environment_variable', secret_name: newCredSecretName.trim(), secret_value: newCredSecretValue.trim() };
                          }
                          void createCloudCredential(ctx, vr.id, auth)
                            .then((cred) => {
                              setVaultCredentials((prev) => [...prev, cred]);
                              setNewCredUrl('');
                              setNewCredToken('');
                              setNewCredSecretName('');
                              setNewCredSecretValue('');
                              setNewCredAccessToken('');
                              setNewCredExpiresAt('');
                            })
                            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                        }}
                        disabled={
                          newCredType === 'static_bearer' ? (!newCredUrl.trim() || !newCredToken.trim()) :
                          newCredType === 'mcp_oauth' ? (!newCredUrl.trim() || !newCredAccessToken.trim()) :
                          (!newCredSecretName.trim() || !newCredSecretValue.trim())
                        }
                        className="flex h-9 w-full items-center justify-center rounded-xl bg-[#3550FF] text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        添加凭据
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Status + created */}
              <div className="flex items-center gap-4 text-xs text-black/40">
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  {vr.status || '已注册'}
                </span>
                {vrCreatedAt && <span>创建于 {relativeTime(vrCreatedAt)}</span>}
              </div>
            </div>

            {/* Actions */}
            <div className="mt-6 flex items-center gap-3">
              {(vr.type === 'environment' || vr.type === 'skill' || vr.type === 'file' || vr.type === 'vault') && (
                <button
                  onClick={() => openEditModal(vr)}
                  className="flex-1 rounded-full bg-[#3550FF] py-2.5 text-center text-sm font-medium text-white hover:bg-[#2a42e0]"
                >
                  编辑
                </button>
              )}
              <button
                onClick={() => setDeleteConfirmResource(vr)}
                className="rounded-full border border-red-200 bg-white px-4 py-2.5 text-sm text-red-500 transition hover:bg-red-50"
              >
                删除
              </button>
              <button onClick={() => setViewingResource(null)} className="rounded-full border border-gray-200 px-4 py-2.5 text-sm text-black/60 hover:bg-gray-50">关闭</button>
            </div>
          </Modal>
        );
      })()}

      {/* Delete resource confirmation */}
      <Modal open={!!deleteConfirmResource} onClose={() => setDeleteConfirmResource(null)} title="确认删除">
        <div className="text-sm text-black/60">
          <p>确定要删除{RESOURCE_TYPE_LABELS[deleteConfirmResource?.type ?? 'skill']} <strong>{deleteConfirmResource?.name || deleteConfirmResource?.id}</strong> 吗？</p>
          <p className="mt-2 text-xs text-black/40">此操作不可撤销，删除后该资源将无法再被模板引用。</p>
        </div>
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={() => void handleDeleteResource()}
            disabled={loading}
            className="flex-1 rounded-full bg-red-500 py-2.5 text-center text-sm font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
          >
            {loading ? '删除中...' : '确认删除'}
          </button>
          <button onClick={() => setDeleteConfirmResource(null)} className="rounded-full border border-gray-200 px-5 py-2.5 text-sm text-black/60 hover:bg-gray-50">取消</button>
        </div>
      </Modal>

      {/* Developer mode confirmation */}
      <Modal open={showDevModeConfirm} onClose={() => setShowDevModeConfirm(false)} title="开启开发者模式？">
        <div className="text-sm leading-relaxed text-black/70">
          <p>开启后将解锁<strong className="text-black">模板</strong>与<strong className="text-black">模板资源（技能 / 文件 / 环境 / 凭据）</strong>的完整管理权限，你可以新建、修改和删除这些内容。</p>
          <div className="mt-3 flex gap-2 rounded-xl border border-[#F5C6C6] bg-[#FEF2F2] px-3.5 py-3 text-[13px] leading-relaxed text-[#b42318]">
            <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
            <span>模板与资源由<strong>所有终端用户共享</strong>。你的任何新建、修改或删除都会<strong>立即对全体用户生效且不可撤销</strong>，请务必谨慎操作。</span>
          </div>
        </div>
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={() => {
              setDeveloperMode(true);
              try { localStorage.setItem('developer_mode', '1'); } catch { /* ignore */ }
              setShowDevModeConfirm(false);
            }}
            className="flex-1 rounded-full bg-[#3550FF] py-2.5 text-center text-sm font-medium text-white transition hover:bg-[#2a42e0]"
          >
            确认开启，我已知晓风险
          </button>
          <button onClick={() => setShowDevModeConfirm(false)} className="rounded-full border border-gray-200 px-5 py-2.5 text-sm text-black/60 hover:bg-gray-50">取消</button>
        </div>
      </Modal>

      {/* Edit resource modal */}
      <Modal open={!!editingResource} onClose={() => { setEditingResource(null); setVaultCredentials([]); setNewCredType('static_bearer'); setNewCredUrl(''); setNewCredToken(''); setNewCredSecretName(''); setNewCredSecretValue(''); setNewCredAccessToken(''); setNewCredExpiresAt(''); }} title={`编辑${editingResource ? RESOURCE_TYPE_LABELS[editingResource.type] : ''}`}>
        <div className="space-y-5">
          {/* Header with icon */}
          {editingResource && (
            <div className="flex items-center gap-3 rounded-xl bg-[#F8F9FF] px-4 py-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-xl shadow-sm">{RESOURCE_ICONS[editingResource.type]}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-black">{editingResource.name || specString(editingResource, 'display_title', 'display_name', 'name') || editingResource.id}</div>
                <div className="mt-0.5 font-mono text-[10px] text-black/35">{editingResource.id}</div>
              </div>
            </div>
          )}

          {/* Name field */}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-black/50">名称</span>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="h-11 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
              autoFocus
            />
          </label>

          {/* Description */}
          {editingResource?.type !== 'file' && editingResource?.type !== 'vault' && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-black/50">描述</span>
              <input
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="简要描述用途"
                className="h-11 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
              />
            </label>
          )}

          {/* Environment networking */}
          {editingResource?.type === 'environment' && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-black/50">网络策略</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setEditNetworking('limited')}
                  className={`rounded-xl py-3 text-center text-xs font-medium transition ${editNetworking === 'limited' ? 'bg-[#3550FF] text-white shadow-sm' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                >
                  <div className="font-medium">受限</div>
                  <div className={`mt-0.5 text-[10px] ${editNetworking === 'limited' ? 'text-white/70' : 'text-black/35'}`}>仅包管理器</div>
                </button>
                <button
                  type="button"
                  onClick={() => setEditNetworking('unrestricted')}
                  className={`rounded-xl py-3 text-center text-xs font-medium transition ${editNetworking === 'unrestricted' ? 'bg-[#3550FF] text-white shadow-sm' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                >
                  <div className="font-medium">完全开放</div>
                  <div className={`mt-0.5 text-[10px] ${editNetworking === 'unrestricted' ? 'text-white/70' : 'text-black/35'}`}>无网络限制</div>
                </button>
              </div>
            </label>
          )}

          {/* Vault credential management */}
          {editingResource?.type === 'vault' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-black/50">凭据管理</span>
                <span className="text-[11px] text-black/35">{vaultCredentials.length} 个凭据</span>
              </div>

              {/* Existing credentials */}
              {vaultCredentials.length > 0 && (
                <div className="space-y-2">
                  {vaultCredentials.map((cred) => (
                    <div key={cred.id} className="flex items-center justify-between rounded-xl bg-[#F8F9FF] px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-black/70">{cred.auth.mcp_server_url || cred.auth.secret_name || cred.id}</div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                            cred.auth.type === 'static_bearer' ? 'bg-blue-100 text-blue-600' :
                            cred.auth.type === 'mcp_oauth' ? 'bg-purple-100 text-purple-600' :
                            'bg-amber-100 text-amber-600'
                          }`}>
                            {cred.auth.type === 'static_bearer' ? 'Bearer' : cred.auth.type === 'mcp_oauth' ? 'OAuth' : 'Env'}
                          </span>
                          <span className="text-[10px] text-black/35">
                            {cred.auth.type === 'static_bearer' ? 'Bearer Token' :
                             cred.auth.type === 'mcp_oauth' ? 'OAuth Token' :
                             '环境变量'}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          if (!ctx || !editingResource) return;
                          void deleteCloudCredential(ctx, editingResource.id, cred.id).then(() => {
                            setVaultCredentials((prev) => prev.filter((c) => c.id !== cred.id));
                          }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                        }}
                        className="ml-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-red-400 transition hover:bg-red-50 hover:text-red-600"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.688 0 .346-9m-4.688 0L8.414 5.25a1.5 1.5 0 0 1 1.06-.44h3.172a1.5 1.5 0 0 1 1.06.44L15.25 9m-4.688 0L15.25 9m-4.688 0h4.688m-8.5 8.25h4.5m-4.5 0a2.25 2.25 0 0 1-2.25-2.25v-4.5a2.25 2.25 0 0 1 2.25-2.25h4.5a2.25 2.25 0 0 1 2.25 2.25v4.5a2.25 2.25 0 0 1-2.25 2.25" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {vaultCredentials.length === 0 && (
                <div className="rounded-xl bg-[#F8F9FF] px-4 py-4 text-center text-xs text-black/40">暂无凭据，请在下方添加</div>
              )}

              {/* Add new credential */}
              <div className="rounded-xl border border-dashed border-[#DDE2F2] p-4">
                <div className="mb-3 text-xs font-medium text-black/50">添加新凭据</div>

                {/* Credential type selector */}
                <div className="mb-3 grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setNewCredType('static_bearer')}
                    className={`rounded-lg py-2 text-[11px] font-medium transition ${newCredType === 'static_bearer' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                  >
                    Bearer Token
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewCredType('mcp_oauth')}
                    className={`rounded-lg py-2 text-[11px] font-medium transition ${newCredType === 'mcp_oauth' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                  >
                    OAuth Token
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewCredType('environment_variable')}
                    className={`rounded-lg py-2 text-[11px] font-medium transition ${newCredType === 'environment_variable' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                  >
                    环境变量
                  </button>
                </div>

                {/* static_bearer / mcp_oauth: MCP Server URL */}
                {(newCredType === 'static_bearer' || newCredType === 'mcp_oauth') && (
                  <input
                    value={newCredUrl}
                    onChange={(e) => setNewCredUrl(e.target.value)}
                    placeholder="MCP Server URL（例如：https://api.example.com/mcp）"
                    className="mb-2 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                  />
                )}

                {/* static_bearer: token */}
                {newCredType === 'static_bearer' && (
                  <input
                    value={newCredToken}
                    onChange={(e) => setNewCredToken(e.target.value)}
                    type="password"
                    placeholder="Bearer Token"
                    className="mb-3 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                  />
                )}

                {/* mcp_oauth: access_token + expires_at */}
                {newCredType === 'mcp_oauth' && (
                  <>
                    <input
                      value={newCredAccessToken}
                      onChange={(e) => setNewCredAccessToken(e.target.value)}
                      type="password"
                      placeholder="OAuth Access Token"
                      className="mb-2 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                    />
                    <input
                      value={newCredExpiresAt}
                      onChange={(e) => setNewCredExpiresAt(e.target.value)}
                      type="datetime-local"
                      placeholder="过期时间（可选）"
                      className="mb-3 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                    />
                  </>
                )}

                {/* environment_variable: secret_name + secret_value */}
                {newCredType === 'environment_variable' && (
                  <>
                    <input
                      value={newCredSecretName}
                      onChange={(e) => setNewCredSecretName(e.target.value)}
                      placeholder="环境变量名（例如：API_KEY）"
                      className="mb-2 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                    />
                    <input
                      value={newCredSecretValue}
                      onChange={(e) => setNewCredSecretValue(e.target.value)}
                      type="password"
                      placeholder="密钥值"
                      className="mb-3 h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
                    />
                  </>
                )}

                <button
                  onClick={() => {
                    if (!ctx || !editingResource) return;
                    let auth: Parameters<typeof createCloudCredential>[2];
                    if (newCredType === 'static_bearer') {
                      if (!newCredUrl.trim() || !newCredToken.trim()) return;
                      auth = { type: 'static_bearer', mcp_server_url: newCredUrl.trim(), token: newCredToken.trim() };
                    } else if (newCredType === 'mcp_oauth') {
                      if (!newCredUrl.trim() || !newCredAccessToken.trim()) return;
                      auth = { type: 'mcp_oauth', mcp_server_url: newCredUrl.trim(), access_token: newCredAccessToken.trim() };
                      if (newCredExpiresAt.trim()) auth.expires_at = newCredExpiresAt.trim();
                    } else {
                      if (!newCredSecretName.trim() || !newCredSecretValue.trim()) return;
                      auth = { type: 'environment_variable', secret_name: newCredSecretName.trim(), secret_value: newCredSecretValue.trim() };
                    }
                    void createCloudCredential(ctx, editingResource.id, auth)
                      .then((cred) => {
                        setVaultCredentials((prev) => [...prev, cred]);
                        setNewCredUrl('');
                        setNewCredToken('');
                        setNewCredSecretName('');
                        setNewCredSecretValue('');
                        setNewCredAccessToken('');
                        setNewCredExpiresAt('');
                      })
                      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                  }}
                  disabled={
                    newCredType === 'static_bearer' ? (!newCredUrl.trim() || !newCredToken.trim()) :
                    newCredType === 'mcp_oauth' ? (!newCredUrl.trim() || !newCredAccessToken.trim()) :
                    (!newCredSecretName.trim() || !newCredSecretValue.trim())
                  }
                  className="flex h-9 w-full items-center justify-center rounded-xl bg-[#3550FF] text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  添加凭据
                </button>
              </div>
            </div>
          )}

          {/* Submit */}
          <button
            onClick={() => void handleSaveEdit()}
            disabled={!ctx || loading || !editName.trim()}
            className="flex h-12 w-full items-center justify-center rounded-xl bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                保存中...
              </span>
            ) : '保存修改'}
          </button>
        </div>
      </Modal>

      {/* Create resource modal */}
      <Modal open={showCreateResourceModal} onClose={() => { setShowCreateResourceModal(false); setNewResName(''); setNewResDesc(''); setNewResNetworking('limited'); setNewResFile(null); }} title={`创建${RESOURCE_TYPE_LABELS[activeResourceType]}`}>
        <div className="space-y-5">
          {/* Header with icon */}
          <div className="flex items-center gap-3 rounded-xl bg-[#F8F9FF] px-4 py-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-xl shadow-sm">{RESOURCE_ICONS[activeResourceType]}</span>
            <div>
              <div className="text-sm font-semibold text-black">{RESOURCE_TYPE_LABELS[activeResourceType]}</div>
              <div className="text-[11px] text-black/40">
                {activeResourceType === 'skill' ? '上传 .zip 技能包，包含 SKILL.md' :
                 activeResourceType === 'file' ? '上传文件供 Agent 使用' :
                 activeResourceType === 'vault' ? '安全存储 API Token 和密钥' :
                 '配置 Agent 运行环境和网络策略'}
              </div>
            </div>
          </div>

          {/* Name field */}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-black/50">
              {activeResourceType === 'vault' ? '凭据库名称' : activeResourceType === 'file' ? '文件名' : '名称'} <span className="text-red-400">*</span>
            </span>
            <input
              value={newResName}
              onChange={(e) => setNewResName(e.target.value)}
              placeholder={activeResourceType === 'skill' ? '例如：customer-reply-skill' : activeResourceType === 'file' ? '例如：config.yaml' : activeResourceType === 'vault' ? '例如：MCP 服务凭据' : '例如：开发环境'}
              className="h-11 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
              autoFocus
            />
          </label>

          {/* File upload */}
          {(activeResourceType === 'skill' || activeResourceType === 'file') && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-black/50">
                {activeResourceType === 'skill' ? '技能文件（.zip）' : '上传文件'} <span className="text-red-400">*</span>
              </span>
              <div className={`rounded-xl border-2 border-dashed transition ${newResFile ? 'border-[#3550FF] bg-[#F8F9FF]' : 'border-[#E5E7EB] bg-white hover:border-[#B8C3FF]'}`}>
                <input
                  type="file"
                  accept={activeResourceType === 'skill' ? '.zip' : '*'}
                  onChange={(e) => setNewResFile(e.target.files?.[0] ?? null)}
                  className="block w-full cursor-pointer px-4 py-4 text-xs text-black/60 file:mr-3 file:rounded-lg file:border-0 file:bg-[#3550FF] file:px-4 file:py-2 file:text-xs file:font-medium file:text-white hover:file:bg-[#2a42e0]"
                />
              </div>
              {activeResourceType === 'skill' && (
                <div className="mt-1.5 text-[11px] text-black/35">ZIP 文件须包含 SKILL.md（含 YAML frontmatter: name, description）</div>
              )}
              {newResFile && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-[#3550FF]/5 px-3 py-2">
                  <svg className="h-4 w-4 shrink-0 text-[#3550FF]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                  <span className="truncate text-xs font-medium text-[#3550FF]">{newResFile.name}</span>
                  <span className="shrink-0 text-[11px] text-black/35">{formatFileSize(newResFile.size)}</span>
                </div>
              )}
            </label>
          )}

          {/* Description */}
          {activeResourceType !== 'file' && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-black/50">描述（可选）</span>
              <input
                value={newResDesc}
                onChange={(e) => setNewResDesc(e.target.value)}
                placeholder="简要描述用途"
                className="h-11 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]"
              />
            </label>
          )}

          {/* Environment networking */}
          {activeResourceType === 'environment' && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-black/50">网络策略</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setNewResNetworking('limited')}
                  className={`rounded-xl py-3 text-center text-xs font-medium transition ${newResNetworking === 'limited' ? 'bg-[#3550FF] text-white shadow-sm' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                >
                  <div className="font-medium">受限</div>
                  <div className={`mt-0.5 text-[10px] ${newResNetworking === 'limited' ? 'text-white/70' : 'text-black/35'}`}>仅包管理器</div>
                </button>
                <button
                  type="button"
                  onClick={() => setNewResNetworking('unrestricted')}
                  className={`rounded-xl py-3 text-center text-xs font-medium transition ${newResNetworking === 'unrestricted' ? 'bg-[#3550FF] text-white shadow-sm' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                >
                  <div className="font-medium">完全开放</div>
                  <div className={`mt-0.5 text-[10px] ${newResNetworking === 'unrestricted' ? 'text-white/70' : 'text-black/35'}`}>无网络限制</div>
                </button>
              </div>
            </label>
          )}

          {/* Vault info */}
          {activeResourceType === 'vault' && (
            <div className="rounded-xl bg-[#FFFCF2] px-4 py-3 text-xs leading-relaxed text-amber-700">
              💡 凭据库创建后，可在编辑页面添加 MCP 服务凭据（URL + Token）
            </div>
          )}

          {/* Submit */}
          <button
            onClick={() => void handleCreateResource()}
            disabled={!ctx || loading || !newResName.trim() || ((activeResourceType === 'skill' || activeResourceType === 'file') && !newResFile)}
            className="flex h-12 w-full items-center justify-center rounded-xl bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                创建中...
              </span>
            ) : '确认创建'}
          </button>
        </div>
      </Modal>

      {/* Template detail modal */}
      {viewingTemplate && (() => {
        const vt = viewingTemplate;
        const vtMcp = extractMcpNames(vt.mcp_servers);
        // Build skill name lookup from loaded resources (only keep real names)
        const skillNameMap = new Map(
          resourceOptionsByType.skill
            .filter((r) => r.name)
            .map((r) => [r.id, r.name as string]),
        );
        const vtSkills = extractSkillInfo(vt.skills).map((s) => {
          const resolved = skillNameMap.get(s.id);
          const displayName = resolved || (s.name && s.name !== s.id ? s.name : '未命名技能');
          return { ...s, name: displayName };
        });
        const vtFiles = fileCount(vt.files);
        const vtEnvVars = vt.environment_variables && typeof vt.environment_variables === 'object'
          ? Object.entries(vt.environment_variables as Record<string, unknown>)
          : [];
        const vtIsActive = templateId === vt.id;

        // Categorize tools
        const builtinToolEntries: Array<{ type: string; names: string[] }> = [];
        const customToolEntries: Array<{ name: string; desc?: string }> = [];
        const mcpToolEntries: Array<{ server: string; names: string[] }> = [];
        if (Array.isArray(vt.tools)) {
          for (const tool of vt.tools) {
            if (!tool || typeof tool !== 'object') continue;
            const r = tool as Record<string, unknown>;
            if (r.type === 'agent_toolset_20260401') {
              const names: string[] = [];
              // From enabled_tools
              if (Array.isArray(r.enabled_tools)) {
                names.push(...r.enabled_tools.filter((t): t is string => typeof t === 'string'));
              }
              // From configs
              if (Array.isArray(r.configs)) {
                for (const config of r.configs) {
                  if (config && typeof config === 'object') {
                    const c = config as Record<string, unknown>;
                    if (typeof c.name === 'string' && c.enabled !== false) {
                      names.push(c.name);
                    }
                  }
                }
              }
              if (names.length > 0) builtinToolEntries.push({ type: '内置工具', names });
            } else if (r.type === 'mcp_toolset' && typeof r.mcp_server_name === 'string') {
              const names: string[] = [];
              if (Array.isArray(r.enabled_tools)) names.push(...r.enabled_tools.filter((t): t is string => typeof t === 'string'));
              if (Array.isArray(r.configs)) {
                for (const config of r.configs) {
                  if (config && typeof config === 'object') {
                    const c = config as Record<string, unknown>;
                    if (typeof c.name === 'string' && c.enabled !== false) names.push(c.name);
                  }
                }
              }
              mcpToolEntries.push({ server: r.mcp_server_name, names });
            } else if (r.type === 'custom' && typeof r.name === 'string') {
              customToolEntries.push({ name: r.name, desc: typeof r.description === 'string' ? r.description : undefined });
            }
          }
        }

        return (
          <Modal open onClose={() => setViewingTemplate(null)} title="模板详情">
            {/* Header */}
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-black">{vt.name || '未命名模板'}</h3>
                {vtIsActive && (
                  <span className="rounded-full bg-[#3550FF]/8 px-2 py-0.5 text-[11px] font-medium text-[#3550FF]">使用中</span>
                )}
              </div>
              {vt.description && <p className="mt-1 text-sm text-black/55">{vt.description}</p>}
              <div className="mt-2 flex items-center gap-2">
                <span className="font-mono text-[11px] text-black/30">{vt.id}</span>
                <button
                  onClick={() => void navigator.clipboard.writeText(vt.id)}
                  className="text-[11px] text-[#3550FF] transition hover:text-[#2a42e0]"
                >复制</button>
              </div>
            </div>

            <div className="space-y-5">
              {/* Basic config */}
              <div className="rounded-xl border border-[#EEF1F7] bg-[#FAFBFF] p-4">
                <div className="mb-3 text-xs font-semibold text-black/50">基础配置</div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-[11px] text-black/40">模型</div>
                    <div className="mt-0.5 font-medium">{getModelLabel(vt.model)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-black/40">环境</div>
                    <div className="mt-0.5 text-sm font-medium" title={vt.environment_id || ''}>
                      {vt.environment_id
                        ? resolveResourceName(resourceOptionsByType.environment, vt.environment_id)
                        : '未设置'}
                    </div>
                  </div>
                </div>
              </div>

              {/* System prompt */}
              <div>
                <div className="mb-2 text-xs font-semibold text-black/50">系统提示词</div>
                {vt.system ? (
                  <div className="max-h-[120px] overflow-y-auto rounded-xl bg-[#FAFBFF] px-4 py-3 text-[13px] leading-relaxed text-black/70 whitespace-pre-wrap">
                    {vt.system}
                  </div>
                ) : (
                  <div className="rounded-xl bg-[#FAFBFF] px-4 py-3 text-xs text-black/30">未设置</div>
                )}
              </div>

              {/* Tools section */}
              {(builtinToolEntries.length > 0 || customToolEntries.length > 0 || mcpToolEntries.length > 0) && (
                <div>
                  <div className="mb-2 text-xs font-semibold text-black/50">工具配置</div>
                  <div className="space-y-2">
                    {builtinToolEntries.map((entry) => (
                      <div key="builtin" className="rounded-xl bg-[#FAFBFF] px-4 py-3">
                        <div className="mb-2 text-[11px] text-black/40">{entry.type}（{entry.names.length} 个）</div>
                        <div className="flex flex-wrap gap-1.5">
                          {entry.names.map((name) => (
                            <span key={name} className="rounded-md bg-white px-2 py-0.5 text-xs text-black/60 shadow-[inset_0_0_0_1px_#E8EBF5]">
                              {name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                    {mcpToolEntries.map((entry) => (
                      <div key={`mcp-${entry.server}`} className="rounded-xl bg-[#FAFBFF] px-4 py-3">
                        <div className="mb-2 text-[11px] text-black/40">MCP 服务: {entry.server}</div>
                        {entry.names.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {entry.names.map((name) => (
                              <span key={name} className="rounded-md bg-white px-2 py-0.5 text-xs text-black/60 shadow-[inset_0_0_0_1px_#E8EBF5]">{name}</span>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-black/35">自动发现全部工具</div>
                        )}
                      </div>
                    ))}
                    {customToolEntries.map((entry) => (
                      <div key={`custom-${entry.name}`} className="rounded-xl bg-[#FAFBFF] px-4 py-3">
                        <div className="text-xs font-medium text-black/70">{entry.name}</div>
                        {entry.desc && <div className="mt-0.5 text-[11px] text-black/40">{entry.desc}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Multi-agent coordinator */}
              {vt.multiagent && vt.multiagent.type === 'coordinator' && Array.isArray(vt.multiagent.agents) && vt.multiagent.agents.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-semibold text-black/50">多 Agent 协作（Coordinator）</div>
                  <div className="rounded-xl bg-[#FAFBFF] px-4 py-3">
                    <div className="mb-2 text-[11px] text-black/40">可委派 Agent（{vt.multiagent.agents.length} 个）</div>
                    <div className="flex flex-wrap gap-1.5">
                      {vt.multiagent.agents.map((entry, i) => (
                        <span key={i} className="rounded-md bg-white px-2 py-0.5 text-xs text-black/60 shadow-[inset_0_0_0_1px_#E8EBF5]" title={entry.id || ''}>
                          {entry.type === 'self' ? '自身（self）' : (entry.name || entry.id || '未知 Agent')}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 text-[11px] text-black/35">运行时自动注入编排工具：Agent / create_agent / send_to_agent / list_agents</div>
                  </div>
                </div>
              )}

              {/* Skills */}
              {vtSkills.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-semibold text-black/50">技能（{vtSkills.length} 个）</div>
                  <div className="space-y-1.5">
                    {vtSkills.map((skill) => (
                      <div key={skill.id} className="flex items-center justify-between rounded-xl bg-[#FAFBFF] px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-black/70">{skill.name}</div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-black/35">{skill.id}</div>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${skill.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-black/35'}`}>
                          {skill.enabled ? '已启用' : '已禁用'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* MCP servers */}
              {vtMcp.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-semibold text-black/50">MCP 服务（{vtMcp.length} 个）</div>
                  <div className="flex flex-wrap gap-2">
                    {vtMcp.map((name) => (
                      <span key={name} className="rounded-lg bg-[#FAFBFF] px-3 py-1.5 text-xs font-medium text-black/60 shadow-[inset_0_0_0_1px_#E8EBF5]">
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Files + Vaults row */}
              {(vtFiles > 0 || (vt.vault_ids && vt.vault_ids.length > 0)) && (
                <div className="flex gap-4">
                  {vtFiles > 0 && (
                    <div className="flex-1 rounded-xl bg-[#FAFBFF] px-4 py-3">
                      <div className="text-[11px] text-black/40">挂载文件</div>
                      <div className="mt-1 text-sm font-medium">{vtFiles} 个</div>
                    </div>
                  )}
                  {vt.vault_ids && vt.vault_ids.length > 0 && (
                    <div className="flex-1 rounded-xl bg-[#FAFBFF] px-4 py-3">
                      <div className="text-[11px] text-black/40">凭据库</div>
                      <div className="mt-1 text-sm font-medium">{vt.vault_ids.length} 个</div>
                    </div>
                  )}
                </div>
              )}

              {/* Environment variables */}
              {vtEnvVars.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-semibold text-black/50">环境变量（{vtEnvVars.length} 个）</div>
                  <div className="space-y-1">
                    {vtEnvVars.map(([key, value]) => (
                      <div key={key} className="flex items-center gap-2 rounded-lg bg-[#FAFBFF] px-3 py-2">
                        <span className="font-mono text-xs font-medium text-[#3550FF]">{key}</span>
                        <span className="text-black/20">=</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-black/55">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="mt-6 flex items-center gap-3">
              <button
                onClick={() => { setTemplateId(vt.id); setActivePanel('chat'); setViewingTemplate(null); void refreshSessions(identity, vt.id); }}
                className={`flex-1 rounded-full py-2.5 text-center text-sm font-medium text-white transition ${
                  vtIsActive ? 'bg-black/15 text-black/50 cursor-default' : 'bg-[#3550FF] hover:bg-[#2a42e0]'
                }`}
                disabled={vtIsActive}
              >
                {vtIsActive ? '当前使用中' : '使用此模板对话'}
              </button>
              {developerMode && (
                <button
                  onClick={() => openEditTemplateModal(vt)}
                  className="rounded-full border border-[#DDE2F2] px-5 py-2.5 text-sm font-medium text-[#3550FF] transition hover:bg-[#F4F6FC]"
                >
                  编辑
                </button>
              )}
              <button onClick={() => setViewingTemplate(null)} className="rounded-full border border-gray-200 px-5 py-2.5 text-sm text-black/60 hover:bg-gray-50">关闭</button>
            </div>
          </Modal>
        );
      })()}

      <Modal open={showTemplateModal} onClose={() => { setShowTemplateModal(false); setEditingTemplateId(null); }} title={editingTemplateId ? '编辑模板' : '新建模板'}>
        <div className="space-y-5">
          <div>
            <div className="mb-3 text-xs font-semibold text-black/40">基本信息</div>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">模板名称</span>
                <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="例如：智能客服助手" className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]" autoFocus />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">描述（可选）</span>
                <input value={templateDescription} onChange={(e) => setTemplateDescription(e.target.value)} placeholder="简要描述这个模板的用途" className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]" />
              </label>
            </div>
          </div>
          <div>
            <div className="mb-3 text-xs font-semibold text-black/40">AI 配置</div>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">模型</span>
                {modelsError ? (
                  <div className="flex items-center gap-2">
                    <div className="flex h-10 flex-1 items-center rounded-xl border border-red-200 bg-red-50 px-3.5 text-sm text-red-600">
                      加载失败: {modelsError.slice(0, 80)}
                    </div>
                    <button
                      type="button"
                      onClick={() => ctx && void loadModels(ctx)}
                      className="shrink-0 rounded-lg border border-[#E5E7EB] bg-white px-3 py-2 text-xs font-medium text-black/60 transition hover:bg-gray-50"
                    >
                      重试
                    </button>
                  </div>
                ) : cloudModels.length > 0 ? (
                  <select
                    value={templateModel}
                    onChange={(e) => setTemplateModel(e.target.value)}
                    className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF]"
                  >
                    {cloudModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display_name}{m.is_new ? ' 🆕' : ''}{m.source === 'user' ? ' (自定义)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div>
                    <input
                      value={templateModel}
                      onChange={(e) => setTemplateModel(e.target.value)}
                      placeholder={modelsLoading ? '加载模型列表中...' : 'API 未返回模型列表，请手动输入模型 ID（如 ultimate）'}
                      className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF] disabled:opacity-50"
                      disabled={modelsLoading}
                    />
                    {!modelsLoading && (
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-[11px] text-amber-600">当前环境未返回可用模型，请手动输入或切换环境</span>
                        <button type="button" onClick={() => ctx && void loadModels(ctx)} className="text-[11px] text-[#3550FF] hover:text-[#2a42e0]">重新加载</button>
                      </div>
                    )}
                  </div>
                )}
                {cloudModels.length > 0 && (
                  <div className="mt-1 text-[11px] text-black/30">共 {cloudModels.length} 个可用模型</div>
                )}
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">系统提示词</span>
                <textarea value={templateSystem} onChange={(e) => setTemplateSystem(e.target.value)} placeholder="设定 AI 的角色和行为规则..." className="min-h-[80px] w-full resize-none rounded-xl border border-[#E5E7EB] bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-[#3550FF] focus:shadow-[0_0_0_3px_rgba(53,80,255,0.08)]" />
              </label>
            </div>
          </div>
          <div>
            <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-black/40">
              运行环境 <span className="text-red-400">*必填</span>
            </div>
            <ResourceSingleSelect
              label=""
              placeholder="选择一个已注册的运行环境"
              emptyText="暂无环境，请先在「环境」页面创建"
              resources={environmentOptions}
              selectedId={environmentId}
              onChange={setEnvironmentId}
              onRefresh={() => void loadResources('environment', false)}
            />
            {!environmentId && <div className="mt-1.5 text-[11px] text-amber-600">模板必须关联一个运行环境</div>}
          </div>
          <details className="rounded-xl border border-[#E5E7EB] bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-black/60 transition hover:text-black/80">高级配置（技能、文件、工具等）</summary>
            <div className="space-y-3 border-t border-[#E5E7EB] p-4">
              <ResourceTokenSelect label="技能" placeholder="选择已注册技能" emptyText="暂无技能" resources={resourceOptionsByType.skill} selectedIds={selectedSkillIds} onAdd={(id) => addSelection(id, setSkillIdsText)} onRemove={(id) => removeSelection(id, setSkillIdsText)} onRefresh={() => void loadResources('skill', false)} />
              <ResourceTokenSelect label="文件" placeholder="选择已注册文件" emptyText="暂无文件" resources={resourceOptionsByType.file} selectedIds={selectedFileIds} onAdd={(id) => addSelection(id, setFileIdsText)} onRemove={(id) => removeSelection(id, setFileIdsText)} onRefresh={() => void loadResources('file', false)} />
              <ResourceTokenSelect label="凭据库" placeholder="选择已注册凭据库" emptyText="暂无凭据库" resources={resourceOptionsByType.vault} selectedIds={selectedVaultIds} onAdd={(id) => addSelection(id, setVaultIdsText)} onRemove={(id) => removeSelection(id, setVaultIdsText)} onRefresh={() => void loadResources('vault', false)} />
              <div className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">内置工具</span>
                <div className="flex flex-wrap gap-1.5">
                  {BUILTIN_TOOLS.map((tool) => {
                    const isSelected = selectedTools.includes(tool);
                    return (
                      <button
                        key={tool}
                        type="button"
                        onClick={() => setSelectedTools((prev) => isSelected ? prev.filter((t) => t !== tool) : [...prev, tool])}
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                          isSelected
                            ? 'bg-[#3550FF] text-white shadow-sm'
                            : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'
                        }`}
                      >
                        {tool}
                      </button>
                    );
                  })}
                </div>
                {selectedTools.length > 0 && (
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[11px] text-black/30">已选择 {selectedTools.length} 个工具</span>
                    <button type="button" onClick={() => setSelectedTools([])} className="text-[11px] text-black/30 hover:text-black/50">清空</button>
                  </div>
                )}
              </div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">环境变量</span>
                <textarea value={envVarsText} onChange={(e) => setEnvVarsText(e.target.value)} placeholder="每行 KEY=value" className="min-h-[60px] w-full resize-none rounded-xl border border-[#E5E7EB] bg-white px-3.5 py-2.5 font-mono text-xs outline-none focus:border-[#3550FF]" />
              </label>
              {/* Multi-Agent (coordinator) — gated on toolset prerequisite */}
              <div className="block border-t border-[#EEF1F7] pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-black/50">多 Agent 协作（Coordinator）</span>
                  {toolsetConfigured && (
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-black/55">
                      <input type="checkbox" checked={multiagentEnabled} onChange={(e) => setMultiagentEnabled(e.target.checked)} className="h-3.5 w-3.5 rounded border-[#E5E7EB] text-[#3550FF] focus:ring-[#3550FF]" />
                      启用
                    </label>
                  )}
                </div>
                {!toolsetConfigured ? (
                  <div className="rounded-lg bg-[#F4F6FC] px-3 py-2 text-[11px] text-black/40">请先在上方选择至少一个内置工具（Toolset）后才能配置多 Agent 能力</div>
                ) : multiagentEnabled ? (
                  <div className="space-y-2">
                    <div className="text-[11px] text-black/40">选择可委派的 Agent（对应其他模板）</div>
                    {managedAgentsLoading ? (
                      <div className="text-[11px] text-black/30">加载 Agent 列表...</div>
                    ) : managedAgents.length === 0 ? (
                      <div className="text-[11px] text-black/30">暂无可委派 Agent</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {managedAgents.map((agent) => {
                          const isSelected = multiagentSelectedAgentIds.includes(agent.id);
                          return (
                            <button key={agent.id} type="button"
                              onClick={() => setMultiagentSelectedAgentIds((prev) => isSelected ? prev.filter((id) => id !== agent.id) : [...prev, agent.id])}
                              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${isSelected ? 'bg-[#3550FF] text-white shadow-sm' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                              title={agent.id}
                            >
                              {agent.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-black/55">
                      <input type="checkbox" checked={multiagentIncludeSelf} onChange={(e) => setMultiagentIncludeSelf(e.target.checked)} className="h-3.5 w-3.5 rounded border-[#E5E7EB] text-[#3550FF] focus:ring-[#3550FF]" />
                      包含自身（self）— 允许委派给自身
                    </label>
                    {(multiagentSelectedAgentIds.length > 0 || multiagentIncludeSelf) && (
                      <div className="text-[11px] text-black/30">
                        已配置 {multiagentSelectedAgentIds.length + (multiagentIncludeSelf ? 1 : 0)} 个可委派 Agent，运行时自动注入编排工具（Agent / create_agent / send_to_agent / list_agents）
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </details>
          <button
            onClick={() => {
              if (!environmentId.trim()) { setError('请先选择一个运行环境'); return; }
              const action = editingTemplateId ? updateExistingTemplate() : createDefaultTemplate();
              void action.then(() => { setShowTemplateModal(false); setEditingTemplateId(null); }).catch(() => {});
            }}
            disabled={!ctx || loading || !environmentId.trim()}
            className="mt-2 flex h-11 w-full items-center justify-center rounded-xl bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (<span className="flex items-center gap-2"><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />{editingTemplateId ? '保存中...' : '创建中...'}</span>) : (editingTemplateId ? '保存' : '创建模板')}
          </button>
        </div>
      </Modal>

      {/* Edit channel modal */}
      <Modal open={!!editingChannelItem} onClose={() => { stopQrPolling(); setEditingChannelItem(null); setQrSession(null); setChanAppKey(''); setChanAppSecret(''); setChanAgentId(''); }} title="渠道配置">
        {editingChannelItem && (() => {
          const chanTypeInfo = CHANNEL_TYPES.find((c) => c.value === editingChannelItem.channel_type);
          const bindingStatusLabel = editingChannelItem.binding_status === 'bound' ? '已连接' : editingChannelItem.binding_status === 'expired' ? '已过期' : '未绑定';
          const bindingStatusColor = editingChannelItem.binding_status === 'bound' ? 'bg-emerald-50 text-emerald-600' : editingChannelItem.binding_status === 'expired' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-black/40';
          return (
            <div className="space-y-3">
              {/* Header: channel type + status */}
              <div className="flex items-center gap-2 rounded-lg bg-[#F8F9FF] px-3 py-2">
                <span className="text-base">{chanTypeInfo?.icon || '💬'}</span>
                <span className="text-sm font-medium text-black/70">{chanTypeInfo?.label || editingChannelItem.channel_type}</span>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${bindingStatusColor}`}>{bindingStatusLabel}</span>
              </div>

              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-black/50">渠道名称 <span className="text-red-400">*</span></span>
                <input value={editingChannelItem.name} onChange={(e) => setEditingChannelItem({ ...editingChannelItem, name: e.target.value })} placeholder="请输入渠道名称" className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 text-sm outline-none transition focus:border-[#3550FF]" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-black/50">绑定模板</span>
                <select value={editingChannelItem.template_id} onChange={(e) => setEditingChannelItem({ ...editingChannelItem, template_id: e.target.value })} className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 text-sm outline-none transition focus:border-[#3550FF]">
                  {templates.map((t) => (<option key={t.id} value={t.id}>{t.name || t.id}</option>))}
                </select>
              </label>

              {/* Binding mode: QR or Manual */}
              {chanTypeInfo?.qrSupport && (
                <div className="rounded-xl border border-[#E5E7EB] bg-[#FAFBFF] p-3">
                  <div className="mb-2 text-[11px] font-medium text-black/50">绑定方式</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => { setChanMode('qr'); stopQrPolling(); setQrSession(null); }} className={`rounded-lg py-2 text-xs font-medium transition ${chanMode === 'qr' ? 'bg-[#3550FF] text-white' : 'bg-white text-black/55 hover:bg-[#E8EBF5]'}`}>📱 扫码授权</button>
                    <button type="button" onClick={() => { setChanMode('manual'); stopQrPolling(); setQrSession(null); }} className={`rounded-lg py-2 text-xs font-medium transition ${chanMode === 'manual' ? 'bg-[#3550FF] text-white' : 'bg-white text-black/55 hover:bg-[#E8EBF5]'}`}>⚙️ 手动配置</button>
                  </div>

                  {/* QR scan sub-section */}
                  {chanMode === 'qr' && (
                    <div className="mt-3 text-center">
                      {editingChannelItem.binding_status === 'bound' && !qrSession && (
                        <div className="py-3">
                          <div className="mb-2 flex items-center justify-center gap-1.5 text-sm font-medium text-emerald-600">
                            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                            已连接
                          </div>
                          <button
                            onClick={() => void handleRebindChannel(editingChannelItem)}
                            className="rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-[11px] font-medium text-black/60 transition hover:bg-gray-50"
                          >
                            🔄 重新绑定
                          </button>
                        </div>
                      )}
                      {qrSession ? (
                        <>
                          <div className="mb-2 text-xs font-medium text-black">
                            {qrSession.status === 'confirmed'
                              ? (qrVerifying ? '扫码成功，正在确认渠道绑定状态…' : qrBindingIssue ? '⚠️ 绑定未完成' : '✅ 绑定成功！')
                              : qrSession.status === 'waiting' ? `请使用${chanTypeInfo?.label || ''}扫码` :
                               qrSession.status === 'scanned' ? '已扫码，请在手机上确认...' :
                               qrSession.status === 'expired' ? '二维码已过期' :
                               qrSession.status === 'denied' ? '用户已拒绝授权' : '发生错误'}
                          </div>
                          {qrSession.qr_code_image_base64 && qrSession.status !== 'confirmed' && (
                            <div className="mx-auto mb-2 inline-block rounded-xl border border-[#E5E7EB] bg-white p-2">
                              <img src={qrSession.qr_code_image_base64} alt="QR Code" className="h-36 w-36" />
                            </div>
                          )}
                          {qrPolling && (qrSession.status === 'waiting' || qrSession.status === 'scanned') && (
                            <div className="mb-1 flex items-center justify-center gap-1.5 text-[11px] text-black/40">
                              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-black/20 border-t-[#3550FF]" />
                              等待确认...
                            </div>
                          )}
                          {qrVerifying && (
                            <div className="mb-1 flex items-center justify-center gap-1.5 text-[11px] text-black/40">
                              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-black/20 border-t-[#3550FF]" />
                              确认绑定状态中...
                            </div>
                          )}
                          {qrSession.err_msg && <div className="mb-1 text-[11px] text-red-500">{qrSession.err_msg}</div>}
                          {qrBindingIssue && !qrVerifying && (
                            <div className="mb-2 rounded-lg bg-amber-50 px-2.5 py-2 text-left text-[11px] leading-4 text-amber-700">{qrBindingIssue}</div>
                          )}
                          {qrSession.status !== 'confirmed' && (
                            <button
                              onClick={() => void handleRebindChannel(editingChannelItem)}
                              className="rounded-lg border border-[#3550FF] bg-white px-3 py-1.5 text-[11px] font-medium text-[#3550FF] transition hover:bg-[#F0F2FF]"
                            >
                              🔄 重新生成
                            </button>
                          )}
                          {qrSession.status === 'confirmed' && qrBindingIssue && !qrVerifying && (
                            <div className="flex items-center justify-center gap-2">
                              <button
                                onClick={() => void handleRecheckBinding(editingChannelItem.id)}
                                className="rounded-lg bg-[#3550FF] px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-[#2a42e0]"
                              >
                                重新检查
                              </button>
                              <button
                                onClick={() => void handleRebindChannel(editingChannelItem)}
                                className="rounded-lg border border-[#3550FF] bg-white px-3 py-1.5 text-[11px] font-medium text-[#3550FF] transition hover:bg-[#F0F2FF]"
                              >
                                🔄 重新扫码
                              </button>
                            </div>
                          )}
                          {qrSession.status === 'confirmed' && !qrBindingIssue && !qrVerifying && (
                            <div className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium text-emerald-600">
                              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                              已连接
                            </div>
                          )}
                        </>
                      ) : editingChannelItem.binding_status !== 'bound' ? (
                        <div className="py-3">
                          <button
                            onClick={() => void handleRebindChannel(editingChannelItem)}
                            disabled={loading}
                            className="rounded-lg bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:opacity-40"
                          >
                            生成二维码
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* Manual config sub-section */}
                  {chanMode === 'manual' && (() => {
                    const keyLabel = editingChannelItem.channel_type === 'feishu' ? 'App ID' : editingChannelItem.channel_type === 'dingtalk' ? 'Client ID' : 'Bot ID';
                    const secretLabel = editingChannelItem.channel_type === 'feishu' ? 'App Secret' : editingChannelItem.channel_type === 'dingtalk' ? 'Client Secret' : 'Secret';
                    return (
                    <div className="mt-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="mb-1 block text-[10px] font-medium text-black/50">{keyLabel}</span>
                          <input value={chanAppKey} onChange={(e) => setChanAppKey(e.target.value)} placeholder={keyLabel} className="h-8 w-full rounded-lg border border-[#E5E7EB] bg-white px-2.5 font-mono text-xs outline-none focus:border-[#3550FF]" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[10px] font-medium text-black/50">{secretLabel}</span>
                          <input value={chanAppSecret} onChange={(e) => setChanAppSecret(e.target.value)} type="password" placeholder={secretLabel} className="h-8 w-full rounded-lg border border-[#E5E7EB] bg-white px-2.5 font-mono text-xs outline-none focus:border-[#3550FF]" />
                        </label>
                      </div>
                      {(editingChannelItem.channel_type === 'wecom' || editingChannelItem.channel_type === 'dingtalk') && (
                        <label className="block">
                          <span className="mb-1 block text-[10px] font-medium text-black/50">{editingChannelItem.channel_type === 'wecom' ? 'Agent ID（可选）' : 'AgentId（可选）'}</span>
                          <input value={chanAgentId} onChange={(e) => setChanAgentId(e.target.value)} placeholder={editingChannelItem.channel_type === 'wecom' ? '企微 AgentId' : '钉钉 AgentId'} className="h-8 w-full rounded-lg border border-[#E5E7EB] bg-white px-2.5 font-mono text-xs outline-none focus:border-[#3550FF]" />
                        </label>
                      )}
                    </div>
                    );
                  })()}
                </div>
              )}

              {/* Response options */}
              <div className="flex items-center justify-between rounded-lg bg-[#FAFBFF] px-3 py-2.5">
                <div className="text-xs text-black/60">展示工具调用过程</div>
                <button type="button" onClick={() => setEditingChannelItem({ ...editingChannelItem, channel_config: { ...editingChannelItem.channel_config, response_options: { ...editingChannelItem.channel_config?.response_options, include_tool_calls: !editingChannelItem.channel_config?.response_options?.include_tool_calls } } })} className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${editingChannelItem.channel_config?.response_options?.include_tool_calls ? 'bg-[#3550FF]' : 'bg-gray-200'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${editingChannelItem.channel_config?.response_options?.include_tool_calls ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-[#FAFBFF] px-3 py-2.5">
                <div className="text-xs text-black/60">展示思考过程</div>
                <button type="button" onClick={() => setEditingChannelItem({ ...editingChannelItem, channel_config: { ...editingChannelItem.channel_config, response_options: { ...editingChannelItem.channel_config?.response_options, include_thinking: !editingChannelItem.channel_config?.response_options?.include_thinking } } })} className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${editingChannelItem.channel_config?.response_options?.include_thinking ? 'bg-[#3550FF]' : 'bg-gray-200'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${editingChannelItem.channel_config?.response_options?.include_thinking ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                </button>
              </div>

              <button
                onClick={() => void handleUpdateChannelItem()}
                disabled={loading || !editingChannelItem.name.trim()}
                className="flex h-10 w-full items-center justify-center rounded-xl bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {!editingChannelItem.name.trim() ? '请输入渠道名称' : loading ? '保存中...' : '保存修改'}
              </button>
            </div>
          );
        })()}
      </Modal>

      {/* Delete channel confirmation */}
      <Modal open={!!deleteChannelId} onClose={() => setDeleteChannelId(null)} title="删除渠道">
        <div className="space-y-4">
          <div className="text-sm text-black/60">确定要删除这个渠道吗？删除后将无法恢复，相关消息路由也会停止。</div>
          <div className="flex gap-3">
            <button
              onClick={() => deleteChannelId && void handleDeleteChannel(deleteChannelId)}
              disabled={loading}
              className="flex h-10 flex-1 items-center justify-center rounded-xl bg-red-500 text-sm font-semibold text-white transition hover:bg-red-600 disabled:opacity-40"
            >
              {loading ? '删除中...' : '确认删除'}
            </button>
            <button onClick={() => setDeleteChannelId(null)} className="h-10 rounded-xl border border-[#E5E7EB] bg-white px-5 text-sm font-medium text-black/60 transition hover:bg-gray-50">取消</button>
          </div>
        </div>
      </Modal>

      <Modal open={showResourceModal} onClose={() => setShowResourceModal(false)} title={`注册${activeResourceLabel}`}>
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-black/45">{activeResourceLabel} ID</span>
            <input value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder={`输入${activeResourceLabel} ID`} className="mt-1 h-11 w-full rounded-xl border border-[#2F3A8026] bg-white px-3 text-sm outline-none focus:border-[#3550FF]" />
          </label>
          <button
            onClick={() => { void registerCurrentResource(); setShowResourceModal(false); }}
            disabled={!ctx || loading || !resourceId.trim()}
            className="h-11 w-full rounded-full bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
          >
            {loading ? '注册中...' : '确认注册'}
          </button>
        </div>
      </Modal>

      <Modal open={showCreateEnvModal} onClose={() => setShowCreateEnvModal(false)} title="添加环境">
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-black/45">名称</span>
            <input value={newEnvName} onChange={(event) => setNewEnvName(event.target.value)} placeholder="例如：my-dev-env" className="mt-1 h-11 w-full rounded-xl border border-[#2F3A8026] bg-white px-3 text-sm outline-none focus:border-[#3550FF]" autoFocus />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-black/45">描述（可选）</span>
            <input value={newEnvDescription} onChange={(event) => setNewEnvDescription(event.target.value)} placeholder="环境描述" className="mt-1 h-11 w-full rounded-xl border border-[#2F3A8026] bg-white px-3 text-sm outline-none focus:border-[#3550FF]" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-black/45">网络策略</span>
            <select
              value={newEnvNetworking}
              onChange={(event) => setNewEnvNetworking(event.target.value as 'unrestricted' | 'limited')}
              className="mt-1 h-11 w-full rounded-xl border border-[#2F3A8026] bg-white px-3 text-sm outline-none focus:border-[#3550FF]"
            >
              <option value="limited">受限（仅包管理器）</option>
              <option value="unrestricted">完全开放</option>
            </select>
          </label>
          <button
            onClick={() => void handleCreateEnvironment()}
            disabled={!ctx || loading || !newEnvName.trim()}
            className="h-11 w-full rounded-full bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
          >
            {loading ? '创建中...' : '确认创建'}
          </button>
        </div>
      </Modal>

      {/* Schedule create/edit modal */}
      <Modal open={showScheduleModal} onClose={() => { setShowScheduleModal(false); setEditingSchedule(null); }} title={editingSchedule ? '编辑定时任务' : '新建定时任务'}>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-black/50">任务名称 <span className="text-red-400">*</span></span>
            <input value={schedName} onChange={(e) => setSchedName(e.target.value)} placeholder="例如：每日早报" className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF]" autoFocus />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-black/50">描述（可选）</span>
            <input value={schedDesc} onChange={(e) => setSchedDesc(e.target.value)} placeholder="简要描述任务用途" className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF]" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-black/50">使用模板 <span className="text-red-400">*</span></span>
            <select value={schedTemplateId} onChange={(e) => setSchedTemplateId(e.target.value)} className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none transition focus:border-[#3550FF]">
              {templates.map((t) => (<option key={t.id} value={t.id}>{t.name || t.id}</option>))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-black/50">执行内容 <span className="text-red-400">*</span></span>
            <textarea value={schedMessage} onChange={(e) => setSchedMessage(e.target.value)} placeholder="每次执行时发送给 AI 的消息内容" className="min-h-[80px] w-full resize-none rounded-xl border border-[#E5E7EB] bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-[#3550FF]" />
          </label>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-black/50">触发方式</span>
            <div className="grid grid-cols-4 gap-2">
              {([['manual', '手动'], ['cron', '定时(Cron)'], ['interval', '固定间隔'], ['once', '一次性']] as const).map(([val, label]) => (
                <button key={val} type="button" onClick={() => setSchedTriggerType(val)} className={`rounded-lg py-2 text-xs font-medium transition ${schedTriggerType === val ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}>{label}</button>
              ))}
            </div>
          </div>
          {schedTriggerType === 'cron' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">Cron 表达式</span>
                <input value={schedExpression} onChange={(e) => setSchedExpression(e.target.value)} placeholder="0 9 * * *" className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 font-mono text-sm outline-none focus:border-[#3550FF]" />
                <span className="mt-1 block text-[11px] text-black/30">5位 cron 表达式，如 "0 9 * * *" 表示每天9点</span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">时区</span>
                <select value={schedTimezone} onChange={(e) => setSchedTimezone(e.target.value)} className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none focus:border-[#3550FF]">
                  <option value="Asia/Shanghai">中国标准时间 (UTC+8)</option>
                  <option value="Asia/Tokyo">日本标准时间 (UTC+9)</option>
                  <option value="America/New_York">美东时间 (UTC-5)</option>
                  <option value="America/Los_Angeles">美西时间 (UTC-8)</option>
                  <option value="Europe/London">伦敦时间 (UTC+0)</option>
                  <option value="UTC">UTC</option>
                </select>
              </label>
            </div>
          )}
          {schedTriggerType === 'interval' && (
            <div>
              <span className="mb-1.5 block text-xs font-medium text-black/50">执行间隔</span>
              <div className="grid grid-cols-4 gap-2">
                {([
                  ['PT5M', '5 分钟'], ['PT15M', '15 分钟'], ['PT30M', '30 分钟'], ['PT1H', '1 小时'],
                  ['PT2H', '2 小时'], ['PT6H', '6 小时'], ['PT12H', '12 小时'], ['P1D', '1 天'],
                ] as const).map(([val, label]) => (
                  <button key={val} type="button" onClick={() => setSchedExpression(val)} className={`rounded-lg py-2 text-xs font-medium transition ${schedExpression === val ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}>{label}</button>
                ))}
              </div>
            </div>
          )}
          {schedTriggerType === 'once' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">执行时间</span>
                <input
                  type="datetime-local"
                  value={schedExpression ? schedExpression.slice(0, 16) : ''}
                  onChange={(e) => setSchedExpression(e.target.value ? e.target.value + ':00' : '')}
                  min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                  className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none focus:border-[#3550FF]"
                />
                <span className="mt-1 block text-[11px] text-black/30">执行时间需晚于当前时间至少 1 分钟</span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-black/50">时区</span>
                <select value={schedTimezone} onChange={(e) => setSchedTimezone(e.target.value)} className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-sm outline-none focus:border-[#3550FF]">
                  <option value="Asia/Shanghai">中国标准时间 (UTC+8)</option>
                  <option value="Asia/Tokyo">日本标准时间 (UTC+9)</option>
                  <option value="America/New_York">美东时间 (UTC-5)</option>
                  <option value="America/Los_Angeles">美西时间 (UTC-8)</option>
                  <option value="Europe/London">伦敦时间 (UTC+0)</option>
                  <option value="UTC">UTC</option>
                </select>
              </label>
            </div>
          )}
          <button
            onClick={() => void handleCreateSchedule()}
            disabled={!ctx || loading || !schedName.trim() || !schedTemplateId || !schedMessage.trim() || (schedTriggerType !== 'manual' && !schedExpression.trim())}
            className="mt-2 flex h-11 w-full items-center justify-center rounded-xl bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? '保存中...' : (editingSchedule ? '保存修改' : '创建任务')}
          </button>
        </div>
      </Modal>

      {/* Channel create modal — 2-step wizard */}
      <Modal open={showChannelModal} onClose={() => {
        // Auto-delete unconfirmed channel on close
        if (createdChannelId && ctx && qrSession?.status !== 'confirmed') {
          void deleteChannel(ctx, createdChannelId).catch(() => {});
        }
        stopQrPolling();
        setShowChannelModal(false);
        setQrSession(null);
        setChanAppKey('');
        setChanAppSecret('');
        setChanAgentId('');
        setCreatedChannelId(null);
        setChannelStep('config');
      }} title={channelStep === 'config' ? '添加 IM 渠道' : '绑定渠道'}>
        {/* Step indicator */}
        <div className="mb-4 flex items-center justify-center gap-3">
          <div className={`flex items-center gap-1.5 text-xs font-medium ${channelStep === 'config' ? 'text-[#3550FF]' : 'text-black/30'}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${channelStep === 'config' ? 'bg-[#3550FF] text-white' : 'bg-[#3550FF]/20 text-[#3550FF]'}`}>1</span>
            基本配置
          </div>
          <div className="h-px w-8 bg-black/10" />
          <div className={`flex items-center gap-1.5 text-xs font-medium ${channelStep === 'binding' || channelStep === 'credentials' ? 'text-[#3550FF]' : 'text-black/30'}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${channelStep === 'binding' || channelStep === 'credentials' ? 'bg-[#3550FF] text-white' : 'bg-black/10 text-black/40'}`}>2</span>
            绑定渠道
          </div>
        </div>

        {channelStep === 'config' ? (
          /* ── Step 1: Configuration ── */
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-black/50">渠道名称 <span className="text-red-400">*</span></span>
                <input value={chanName} onChange={(e) => setChanName(e.target.value)} placeholder="请输入渠道名称" className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 text-sm outline-none transition focus:border-[#3550FF]" autoFocus />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-black/50">绑定模板</span>
                <select value={chanTemplateId} onChange={(e) => setChanTemplateId(e.target.value)} className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 text-sm outline-none transition focus:border-[#3550FF]">
                  {templates.map((t) => (<option key={t.id} value={t.id}>{t.name || t.id}</option>))}
                </select>
              </label>
            </div>

            {/* Platform selection */}
            <div className="grid grid-cols-4 gap-2">
              {CHANNEL_TYPES.map((ct) => (
                <button key={ct.value} type="button" onClick={() => { setChanType(ct.value); if (!ct.qrSupport) setChanMode('manual'); else setChanMode('qr'); }} className={`flex items-center justify-center gap-1 rounded-lg py-2 text-xs font-medium transition ${chanType === ct.value ? 'bg-[#3550FF] text-white shadow-sm' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}>
                  <span className="text-sm">{ct.icon}</span>
                  {ct.label}
                </button>
              ))}
            </div>

            {/* Response options */}
            <div className="space-y-2 rounded-lg bg-[#FAFBFF] px-3 py-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-black/60">展示工具调用过程</div>
                  <div className="text-[10px] text-black/35">回复中显示 AI 使用的工具</div>
                </div>
                <button type="button" onClick={() => setChanShowTools(!chanShowTools)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${chanShowTools ? 'bg-[#3550FF]' : 'bg-gray-200'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${chanShowTools ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-black/60">展示思考过程</div>
                  <div className="text-[10px] text-black/35">回复中显示 AI 的思考</div>
                </div>
                <button type="button" onClick={() => setChanShowThinking(!chanShowThinking)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${chanShowThinking ? 'bg-[#3550FF]' : 'bg-gray-200'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${chanShowThinking ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>

            {/* Next button */}
            <button
              onClick={() => setChannelStep(chanMode === 'qr' && CHANNEL_TYPES.find((c) => c.value === chanType)?.qrSupport ? 'binding' : 'credentials')}
              disabled={!ctx || !chanName.trim()}
              className="flex h-11 w-full items-center justify-center rounded-xl bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {!chanName.trim() ? '请输入渠道名称' : '下一步 →'}
            </button>
          </div>
        ) : (
          /* ── Step 2: Binding ── */
          <div className="space-y-3">
            {/* Summary header */}
            <div className="flex items-center gap-2 rounded-lg bg-[#F8F9FF] px-3 py-2">
              <span className="text-base">{CHANNEL_TYPES.find((c) => c.value === chanType)?.icon || '💬'}</span>
              <span className="text-sm font-medium text-black/70">{chanName}</span>
              <span className="ml-auto text-[10px] text-black/40">{CHANNEL_TYPES.find((c) => c.value === chanType)?.label}</span>
            </div>

            {/* Mode toggle */}
            {CHANNEL_TYPES.find((c) => c.value === chanType)?.qrSupport && CHANNEL_TYPES.find((c) => c.value === chanType)?.manualSupport && (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setChanMode('qr'); stopQrPolling(); setQrSession(null); }} className={`rounded-lg py-2 text-xs font-medium transition ${chanMode === 'qr' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}>📱 扫码授权</button>
                <button type="button" onClick={() => { setChanMode('manual'); stopQrPolling(); setQrSession(null); setCreatedChannelId(null); }} className={`rounded-lg py-2 text-xs font-medium transition ${chanMode === 'manual' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}>⚙️ 手动配置</button>
              </div>
            )}

            {/* QR section */}
            {chanMode === 'qr' && CHANNEL_TYPES.find((c) => c.value === chanType)?.qrSupport && (
              <div className="rounded-xl border border-[#E5E7EB] bg-[#FAFBFF] p-3 text-center">
                {qrSession ? (
                  <>
                    <div className="mb-2 text-xs font-medium text-black">
                      {qrSession.status === 'confirmed'
                        ? (qrVerifying ? '扫码成功，正在确认渠道绑定状态…' : qrBindingIssue ? '⚠️ 绑定未完成' : '✅ 绑定成功！渠道已就绪')
                        : qrSession.status === 'waiting' ? `请使用${CHANNEL_TYPES.find((c) => c.value === chanType)?.label || ''}扫码` :
                         qrSession.status === 'scanned' ? '已扫码，请在手机上确认...' :
                         qrSession.status === 'expired' ? '二维码已过期' :
                         qrSession.status === 'denied' ? '用户已拒绝授权' : '发生错误'}
                    </div>
                    {qrSession.qr_code_image_base64 && qrSession.status !== 'confirmed' && (
                      <div className="mx-auto mb-2 inline-block rounded-xl border border-[#E5E7EB] bg-white p-2">
                        <img src={qrSession.qr_code_image_base64} alt="QR Code" className="h-32 w-32" />
                      </div>
                    )}
                    {qrPolling && (qrSession.status === 'waiting' || qrSession.status === 'scanned') && (
                      <div className="mb-1 flex items-center justify-center gap-1.5 text-[11px] text-black/40">
                        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-black/20 border-t-[#3550FF]" />
                        等待确认...
                      </div>
                    )}
                    {qrVerifying && (
                      <div className="mb-1 flex items-center justify-center gap-1.5 text-[11px] text-black/40">
                        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-black/20 border-t-[#3550FF]" />
                        确认绑定状态中...
                      </div>
                    )}
                    {qrSession.err_msg && <div className="mb-1 text-[11px] text-red-500">{qrSession.err_msg}</div>}
                    {qrBindingIssue && !qrVerifying && (
                      <div className="mb-2 rounded-lg bg-amber-50 px-2.5 py-2 text-left text-[11px] leading-4 text-amber-700">{qrBindingIssue}</div>
                    )}
                    {qrSession.status !== 'confirmed' && (
                      <button
                        onClick={() => { if (createdChannelId) void startQrSession(createdChannelId); }}
                        className="rounded-lg border border-[#3550FF] bg-white px-3 py-1.5 text-[11px] font-medium text-[#3550FF] transition hover:bg-[#F0F2FF]"
                      >
                        🔄 重新生成
                      </button>
                    )}
                    {qrSession.status === 'confirmed' && qrBindingIssue && !qrVerifying && createdChannelId && (
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => void handleRecheckBinding(createdChannelId, { enable: true, closeOnBound: true })}
                          className="rounded-lg bg-[#3550FF] px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-[#2a42e0]"
                        >
                          重新检查
                        </button>
                        <button
                          onClick={() => void startQrSession(createdChannelId)}
                          className="rounded-lg border border-[#3550FF] bg-white px-3 py-1.5 text-[11px] font-medium text-[#3550FF] transition hover:bg-[#F0F2FF]"
                        >
                          🔄 重新扫码
                        </button>
                      </div>
                    )}
                  </>
                ) : createdChannelId ? (
                  <div className="py-4">
                    <span className="mx-auto block h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-[#3550FF]" />
                    <div className="mt-2 text-[11px] text-black/40">生成中...</div>
                  </div>
                ) : (
                  <div className="py-2">
                    <button
                      onClick={() => void handleCreateChannelAndQr()}
                      disabled={!ctx || loading || templates.length === 0}
                      className="rounded-lg bg-[#3550FF] px-5 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {loading ? '生成中...' : '生成二维码'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Manual credentials section */}
            {chanMode === 'manual' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-black/50">{chanType === 'feishu' ? 'App ID' : chanType === 'dingtalk' ? 'Client ID' : 'Bot ID'} <span className="text-red-400">*</span></span>
                    <input value={chanAppKey} onChange={(e) => setChanAppKey(e.target.value)} placeholder={chanType === 'feishu' ? 'App ID' : chanType === 'dingtalk' ? 'Client ID' : 'Bot ID'} className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 font-mono text-xs outline-none transition focus:border-[#3550FF]" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-black/50">{chanType === 'feishu' ? 'App Secret' : chanType === 'dingtalk' ? 'Client Secret' : 'Secret'} <span className="text-red-400">*</span></span>
                    <input value={chanAppSecret} onChange={(e) => setChanAppSecret(e.target.value)} type="password" placeholder={chanType === 'feishu' ? 'App Secret' : chanType === 'dingtalk' ? 'Client Secret' : 'Secret'} className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 font-mono text-xs outline-none transition focus:border-[#3550FF]" />
                  </label>
                </div>
                {(chanType === 'wecom' || chanType === 'dingtalk') && (
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-black/50">{chanType === 'wecom' ? 'Agent ID（可选）' : 'AgentId（可选）'}</span>
                    <input value={chanAgentId} onChange={(e) => setChanAgentId(e.target.value)} placeholder={chanType === 'wecom' ? '企微 AgentId' : '钉钉 AgentId'} className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 font-mono text-xs outline-none transition focus:border-[#3550FF]" />
                  </label>
                )}
              </div>
            )}

            {/* Bottom buttons: back + save */}
            <div className="flex gap-3">
              <button
                onClick={() => {
                  // Going back: clean up any created channel
                  if (createdChannelId && ctx) {
                    void deleteChannel(ctx, createdChannelId).catch(() => {});
                  }
                  stopQrPolling();
                  setQrSession(null);
                  setCreatedChannelId(null);
                  setChannelStep('config');
                }}
                className="h-11 rounded-xl border border-[#E5E7EB] bg-white px-5 text-sm font-medium text-black/60 transition hover:bg-gray-50"
              >
                ← 上一步
              </button>
              {(() => {
                const isQr = chanMode === 'qr' && CHANNEL_TYPES.find((c) => c.value === chanType)?.qrSupport;
                const qrConfirmed = isQr && qrSession?.status === 'confirmed' && !qrBindingIssue && !qrVerifying;
                const manualReady = chanMode === 'manual' && chanAppKey.trim() && chanAppSecret.trim();
                const isDisabled = isQr ? !qrConfirmed : (!manualReady || loading);
                const btnText = loading ? '保存中...' : isQr
                  ? (qrVerifying ? '确认绑定状态中...' : qrBindingIssue ? '绑定未完成' : qrConfirmed ? '保存' : '等待扫码确认...')
                  : '保存';

                return (
                  <button
                    onClick={() => {
                      if (isQr && qrConfirmed) {
                        stopQrPolling();
                        setShowChannelModal(false);
                        setQrSession(null);
                        setChanName('');
                        setCreatedChannelId(null);
                        setChannelStep('config');
                        void loadChannels();
                      } else if (!isQr) {
                        void handleSaveCredentials();
                      }
                    }}
                    disabled={!ctx || isDisabled}
                    className="flex h-11 flex-1 items-center justify-center rounded-xl bg-[#3550FF] text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {btnText}
                  </button>
                );
              })()}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
