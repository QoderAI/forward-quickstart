export const DEFAULT_FORWARD_ENVIRONMENT_ID = 'env_019ef4d7c6c9742fa028eeed7ec232b5';

export type ForwardApiEnvironment = 'cn-prod' | 'global-prod';

export interface ForwardContext {
  pat: string;
  environment: ForwardApiEnvironment;
}

export interface ForwardIdentity {
  id: string;
  external_id: string;
  name: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

export interface ForwardTemplate {
  id: string;
  name: string;
  description?: string;
  status: string;
  model: string;
  system?: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
  skills?: unknown[];
  environment_id?: string;
  vault_ids?: string[];
  files?: unknown;
  environment_variables?: unknown;
}

export type ForwardResourceType = 'skill' | 'file' | 'environment' | 'vault' | 'memory_store';

export interface ForwardResource {
  id: string;
  type: ForwardResourceType;
  owner_type: string;
  owner_id: string;
  name?: string;
  description?: string;
  status?: string;
  version?: number | null;
  resource_spec?: Record<string, unknown>;
}

export interface CreateTemplateInput {
  name?: string;
  description?: string;
  model: string;
  system: string;
  tools: unknown[];
  mcp_servers: unknown[];
  skills: unknown[];
  environment_id: string;
  vault_ids: string[];
  files: Record<string, unknown>;
  environment_variables: Record<string, unknown>;
}

export interface ForwardSession {
  id: string;
  type: string;
  identity_id: string;
  template_id: string;
  status: string;
  title: string;
  source_type?: string;
  template?: { id: string; name?: string; model?: string };
  stats?: { active_seconds?: number; duration_seconds?: number };
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
}

export interface ForwardEvent {
  id: string;
  type: string;
  session_id: string;
  turn_id?: string;
  created_at?: string;
  processed_at?: string;
  content?: string | { type?: string; text?: string; [key: string]: unknown } | Array<{ type?: string; text?: string; [key: string]: unknown }>;
  status?: string;
  reason?: string;
  error?: unknown;
  [key: string]: unknown;
}

interface Page<T> {
  data: T[];
  first_id?: string | null;
  last_id?: string | null;
  has_more: boolean;
}

const LIST_EVENT_TYPES = [
  'user.message',
  'agent.message',
  'agent.thinking',
  'agent.tool_use',
  'agent.custom_tool_use',
  'agent.mcp_tool_use',
  'agent.tool_result',
  'agent.custom_tool_result',
  'agent.mcp_tool_result',
].join(',');

export class ForwardApiError extends Error {
  status: number;
  requestId?: string;

  constructor(status: number, message: string, requestId?: string) {
    super(message);
    this.name = 'ForwardApiError';
    this.status = status;
    this.requestId = requestId;
  }
}

async function forwardRequest<T>(
  ctx: ForwardContext,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch('/api/forward/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pat: ctx.pat,
      environment: ctx.environment,
      method,
      path,
      body,
      query,
      idempotencyKey: method.toUpperCase() === 'POST'
        ? `fw-${Date.now()}-${Math.random().toString(36).slice(2)}`
        : undefined,
    }),
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  const dataRecord = data && typeof data === 'object'
    ? data as {
      request_id?: string;
      requestId?: string;
      message?: string;
      error?: { request_id?: string; requestId?: string; message?: string };
    }
    : null;
  if (!res.ok) {
    const requestId = res.headers.get('x-request-id') ||
      dataRecord?.request_id ||
      dataRecord?.requestId ||
      dataRecord?.error?.request_id ||
      dataRecord?.error?.requestId;
    // Show raw upstream response when JSON parsing fails, so user can report to API provider
    const rawSnippet = text && !data ? `\n[原始响应] ${text.slice(0, 500)}` : '';
    const message = dataRecord?.error?.message || dataRecord?.message || `Forward API error ${res.status}${rawSnippet}`;
    throw new ForwardApiError(
      res.status,
      requestId ? `${message} (request id: ${requestId})` : message,
      requestId || undefined,
    );
  }
  return data as T;
}

async function cloudRequest<T>(
  ctx: ForwardContext,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch('/api/cloud/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pat: ctx.pat,
      environment: ctx.environment,
      method,
      path,
      body,
      query,
    }),
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const errObj = data && typeof data === 'object' ? data as Record<string, unknown> : null;
    const error = errObj?.error as Record<string, unknown> | undefined;
    // Show raw upstream response when JSON parsing fails, so user can report to API provider
    const rawSnippet = text && !data ? `\n[原始响应] ${text.slice(0, 500)}` : '';
    const message = (error?.message as string) || (errObj?.message as string) || `Cloud API error ${res.status}${rawSnippet}`;
    throw new ForwardApiError(res.status, message);
  }
  return data as T;
}

export interface CloudEnvironment {
  id: string;
  type: string;
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  created_at?: string;
}

export async function createCloudEnvironment(
  ctx: ForwardContext,
  input: { name: string; description?: string; networking?: 'unrestricted' | 'limited' },
) {
  return cloudRequest<CloudEnvironment>(ctx, 'POST', '/environments', {
    name: input.name,
    description: input.description || '',
    config: {
      type: 'cloud',
      networking: { type: input.networking || 'limited' },
    },
  });
}

export interface CloudModel {
  id: string;
  type: 'model';
  display_name: string;
  source?: string;
  is_enabled?: boolean;
  is_new?: boolean;
  price_factor?: number;
  efforts?: string[];
  default_effort?: string;
}

export async function listCloudModels(ctx: ForwardContext) {
  return cloudRequest<{ data: CloudModel[]; has_more: boolean }>(ctx, 'GET', '/models');
}

export async function listCloudEnvironments(ctx: ForwardContext) {
  return cloudRequest<{ data: CloudEnvironment[] }>(ctx, 'GET', '/environments', undefined, {
    limit: 50,
  });
}

export async function getCloudEnvironment(ctx: ForwardContext, envId: string) {
  return cloudRequest<CloudEnvironment>(ctx, 'GET', `/environments/${encodeURIComponent(envId)}`);
}

export async function updateCloudEnvironment(
  ctx: ForwardContext,
  envId: string,
  input: { name?: string; description?: string; config?: Record<string, unknown> },
) {
  return cloudRequest<CloudEnvironment>(ctx, 'POST', `/environments/${encodeURIComponent(envId)}`, input);
}

export async function archiveCloudEnvironment(ctx: ForwardContext, envId: string) {
  return cloudRequest<CloudEnvironment>(ctx, 'POST', `/environments/${encodeURIComponent(envId)}/archive`);
}

export async function deleteCloudEnvironment(ctx: ForwardContext, envId: string) {
  return cloudRequest<{ id: string; type: string }>(ctx, 'DELETE', `/environments/${encodeURIComponent(envId)}`);
}

// ─── Skills (Cloud API) ────────────────────────────────────────────

export interface CloudSkill {
  id: string;
  type: 'skill';
  name: string;
  display_title?: string;
  description?: string;
  source?: string;
  latest_version?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export async function listCloudSkills(ctx: ForwardContext) {
  return cloudRequest<{ data: CloudSkill[] }>(ctx, 'GET', '/skills', undefined, { limit: 50 });
}

export async function getCloudSkill(ctx: ForwardContext, skillId: string) {
  return cloudRequest<CloudSkill>(ctx, 'GET', `/skills/${encodeURIComponent(skillId)}`);
}

export async function uploadCloudSkill(
  ctx: ForwardContext,
  input: { name: string; description?: string; file: File },
) {
  const uploadForm = new FormData();
  uploadForm.append('pat', ctx.pat);
  uploadForm.append('environment', ctx.environment);
  uploadForm.append('path', '/skills');
  uploadForm.append('file', input.file);
  uploadForm.append('name', input.name);
  if (input.description) uploadForm.append('description', input.description);

  const uploadRes = await fetch('/api/cloud/upload', {
    method: 'POST',
    body: uploadForm,
  });

  const text = await uploadRes.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: { message: text } }; }
  }
  const dataRecord = data && typeof data === 'object'
    ? data as { error?: { message?: string } }
    : null;
  if (!uploadRes.ok) {
    const message = dataRecord?.error?.message || `Upload failed: ${uploadRes.status}`;
    throw new ForwardApiError(uploadRes.status, message);
  }
  return data as CloudSkill;
}

export async function updateCloudSkill(
  ctx: ForwardContext,
  skillId: string,
  input: { name?: string; description?: string },
) {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  return cloudRequest<CloudSkill>(ctx, 'PUT', `/skills/${encodeURIComponent(skillId)}`, body);
}

export async function deleteCloudSkill(ctx: ForwardContext, skillId: string) {
  return cloudRequest<{ id: string; type: string }>(ctx, 'DELETE', `/skills/${encodeURIComponent(skillId)}`);
}

// ─── Files (Cloud API) ─────────────────────────────────────────────

export interface CloudFile {
  id: string;
  type: 'file';
  filename: string;
  size_bytes: number;
  mime_type?: string;
  downloadable?: boolean;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export async function listCloudFiles(ctx: ForwardContext) {
  return cloudRequest<{ data: CloudFile[] }>(ctx, 'GET', '/files', undefined, { limit: 50 });
}

export async function getCloudFile(ctx: ForwardContext, fileId: string) {
  return cloudRequest<CloudFile>(ctx, 'GET', `/files/${encodeURIComponent(fileId)}`);
}

export async function uploadCloudFile(
  ctx: ForwardContext,
  input: { file: File; name?: string; metadata?: Record<string, unknown> },
) {
  const uploadForm = new FormData();
  uploadForm.append('pat', ctx.pat);
  uploadForm.append('environment', ctx.environment);
  uploadForm.append('path', '/files');
  uploadForm.append('file', input.file);
  if (input.name) uploadForm.append('name', input.name);
  if (input.metadata) uploadForm.append('metadata', JSON.stringify(input.metadata));

  const res = await fetch('/api/cloud/upload', {
    method: 'POST',
    body: uploadForm,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error?.message || `Upload failed: ${res.status}`;
    throw new ForwardApiError(res.status, message);
  }
  return data as CloudFile;
}

export async function downloadCloudFile(ctx: ForwardContext, fileId: string) {
  return cloudRequest<{ url: string; expires_at?: string }>(ctx, 'GET', `/files/${encodeURIComponent(fileId)}/content`);
}

export async function deleteCloudFile(ctx: ForwardContext, fileId: string) {
  return cloudRequest<{ id: string; type: string }>(ctx, 'DELETE', `/files/${encodeURIComponent(fileId)}`);
}

// ─── Vaults (Cloud API) ────────────────────────────────────────────

export interface CloudVault {
  id: string;
  type: 'vault';
  display_name: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export async function listCloudVaults(ctx: ForwardContext) {
  return cloudRequest<{ data: CloudVault[] }>(ctx, 'GET', '/vaults', undefined, { limit: 50 });
}

export async function getCloudVault(ctx: ForwardContext, vaultId: string) {
  return cloudRequest<CloudVault>(ctx, 'GET', `/vaults/${encodeURIComponent(vaultId)}`);
}

export async function createCloudVault(ctx: ForwardContext, input: { display_name: string; metadata?: Record<string, unknown> }) {
  return cloudRequest<CloudVault>(ctx, 'POST', '/vaults', {
    display_name: input.display_name,
    metadata: input.metadata || { created_by: 'forward-quickstart' },
  });
}

export async function archiveCloudVault(ctx: ForwardContext, vaultId: string) {
  return cloudRequest<CloudVault>(ctx, 'POST', `/vaults/${encodeURIComponent(vaultId)}/archive`);
}

export async function deleteCloudVault(ctx: ForwardContext, vaultId: string) {
  return cloudRequest<{ id: string; type: string }>(ctx, 'DELETE', `/vaults/${encodeURIComponent(vaultId)}`);
}

// ─── Vault Credentials (Cloud API) ─────────────────────────────────

export interface CloudCredential {
  id: string;
  type: 'vault_credential';
  vault_id: string;
  auth: { type: string; mcp_server_url?: string; secret_name?: string };
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export async function listCloudCredentials(ctx: ForwardContext, vaultId: string) {
  return cloudRequest<{ data: CloudCredential[] }>(ctx, 'GET', `/vaults/${encodeURIComponent(vaultId)}/credentials`, undefined, { limit: 50 });
}

export type CredentialAuth =
  | { type: 'static_bearer'; mcp_server_url: string; token: string }
  | { type: 'mcp_oauth'; mcp_server_url: string; access_token: string; expires_at?: string; refresh?: { refresh_token?: string; client_secret?: string } }
  | { type: 'environment_variable'; secret_name: string; secret_value: string };

export async function createCloudCredential(
  ctx: ForwardContext,
  vaultId: string,
  auth: CredentialAuth,
  metadata?: Record<string, unknown>,
) {
  return cloudRequest<CloudCredential>(ctx, 'POST', `/vaults/${encodeURIComponent(vaultId)}/credentials`, {
    auth,
    ...(metadata ? { metadata } : {}),
  });
}

export async function deleteCloudCredential(ctx: ForwardContext, vaultId: string, credentialId: string) {
  return cloudRequest<{ id: string; type: string }>(ctx, 'DELETE', `/vaults/${encodeURIComponent(vaultId)}/credentials/${encodeURIComponent(credentialId)}`);
}

export async function listIdentities(ctx: ForwardContext, externalId: string) {
  return forwardRequest<Page<ForwardIdentity>>(ctx, 'GET', '/identities', undefined, {
    external_id: externalId,
    limit: 20,
  });
}

export async function createIdentity(ctx: ForwardContext, externalId: string, name: string) {
  return forwardRequest<ForwardIdentity>(ctx, 'POST', '/identities', {
    external_id: externalId,
    name,
    enabled: true,
    metadata: { created_by: 'forward-quickstart' },
  });
}

export async function ensureIdentity(ctx: ForwardContext, externalId: string) {
  const existing = await listIdentities(ctx, externalId);
  const found = existing.data.find((item) => item.external_id === externalId);
  if (found) return found;
  return createIdentity(ctx, externalId, externalId);
}

export async function createAccessToken(ctx: ForwardContext, identityId: string) {
  return forwardRequest<{
    access_token: string;
    token_type: string;
    expires_at: string;
    identity_id: string;
  }>(ctx, 'POST', `/identities/${encodeURIComponent(identityId)}/access_tokens`, {
    metadata: { created_by: 'forward-quickstart' },
  });
}

export async function listTemplates(ctx: ForwardContext) {
  return forwardRequest<Page<ForwardTemplate>>(ctx, 'GET', '/templates', undefined, {
    status: 'active',
    limit: 50,
  });
}

export async function createTemplate(ctx: ForwardContext, input?: Partial<CreateTemplateInput>) {
  const createdAt = Date.now();
  const environmentId = input?.environment_id?.trim();
  if (!environmentId) {
    throw new Error('请先在「环境」页面注册并选择一个 Environment');
  }

  return forwardRequest<ForwardTemplate>(ctx, 'POST', '/templates', {
    name: input?.name?.trim() || `Forward Quickstart ${new Date(createdAt).toLocaleString()}`,
    description: input?.description?.trim() || undefined,
    environment_id: environmentId,
    model: input?.model?.trim() || 'ultimate',
    system: input?.system?.trim() || '你是 Forward quickstart 测试助手，请用简洁、准确的方式回答用户。',
    tools: input?.tools ?? [],
    mcp_servers: input?.mcp_servers ?? [],
    skills: input?.skills ?? [],
    vault_ids: input?.vault_ids ?? [],
    files: input?.files ?? {},
    environment_variables: input?.environment_variables ?? {},
    metadata: { created_by: 'forward-quickstart' },
  });
}

export async function registerResource(ctx: ForwardContext, type: ForwardResourceType, id: string, name?: string) {
  return forwardRequest<ForwardResource>(ctx, 'POST', '/resources/registry', {
    type,
    resource: { id, ...(name ? { name } : {}) },
  });
}

export async function deleteForwardResource(ctx: ForwardContext, resourceId: string) {
  return forwardRequest<{ id: string; type: string; deleted: boolean }>(ctx, 'DELETE', `/resources/${encodeURIComponent(resourceId)}`);
}

export async function listResources(ctx: ForwardContext, type: ForwardResourceType) {
  return forwardRequest<Page<ForwardResource>>(ctx, 'GET', '/resources', undefined, {
    type,
    limit: 50,
  });
}

export interface EffectiveSpecResp {
  type: string;
  identity_id: string;
  template_id: string;
  agent_effective_hash: string;
  session_effective_hash: string;
  effective_hash: string;
  agent: Record<string, unknown>;
  session: Record<string, unknown> & {
    system_resources?: Array<{
      type: string;
      memory_store_id?: string;
      managed_by?: string;
      binding_key?: string;
    }>;
  };
}

export async function getEffectiveSpec(ctx: ForwardContext, identityId: string, templateId: string) {
  return forwardRequest<EffectiveSpecResp>(ctx, 'GET', `/identities/${encodeURIComponent(identityId)}/templates/${encodeURIComponent(templateId)}/effective`);
}

export async function listSessions(ctx: ForwardContext, identityId: string, templateId?: string) {
  const page = await forwardRequest<Page<ForwardSession>>(ctx, 'GET', '/sessions', undefined, {
    identity_id: identityId,
    template_id: templateId,
    include_archived: false,
    order: 'desc',
    limit: 50,
  });
  // Client-side filter: API may not strictly filter by identity_id in PAT mode
  page.data = page.data.filter((s) => s.identity_id === identityId);
  return page;
}

export async function createSession(
  ctx: ForwardContext,
  identityId: string,
  templateId: string,
  title: string,
) {
  return forwardRequest<ForwardSession>(ctx, 'POST', '/sessions', {
    identity_id: identityId,
    template_id: templateId,
    title,
    incremental_streaming_enabled: true,
    metadata: { created_by: 'forward-quickstart' },
  });
}

export async function archiveSession(ctx: ForwardContext, sessionId: string) {
  return forwardRequest<ForwardSession>(ctx, 'POST', `/sessions/${encodeURIComponent(sessionId)}/archive`);
}

export async function cancelSession(ctx: ForwardContext, sessionId: string) {
  return forwardRequest<{ id: string; type: string; status: string }>(
    ctx,
    'POST',
    `/sessions/${encodeURIComponent(sessionId)}/cancel`,
  );
}

export async function sendUserMessage(ctx: ForwardContext, sessionId: string, text: string) {
  return forwardRequest<{ data: ForwardEvent[] }>(
    ctx,
    'POST',
    `/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text }],
        },
      ],
    },
  );
}

export async function listEvents(ctx: ForwardContext, sessionId: string) {
  return forwardRequest<Page<ForwardEvent>>(
    ctx,
    'GET',
    `/sessions/${encodeURIComponent(sessionId)}/events`,
    undefined,
    { limit: 100, order: 'desc', types: LIST_EVENT_TYPES },
  );
}

export function eventText(event: ForwardEvent): string {
  if (typeof event.content === 'string') return event.content;
  if (Array.isArray(event.content)) {
    return event.content
      .map((item) => item.text)
      .filter((text): text is string => typeof text === 'string')
      .join('');
  }
  if (event.content && typeof event.content === 'object' && typeof event.content.text === 'string') {
    return event.content.text;
  }
  if (event.reason) return event.reason;
  if (event.status) return event.status;
  if (event.error) return typeof event.error === 'string' ? event.error : JSON.stringify(event.error);
  return '';
}

export async function streamEvents(
  ctx: ForwardContext,
  sessionId: string,
  onEvent: (event: ForwardEvent) => void,
  signal?: AbortSignal,
  lastEventId?: string,
) {
  const params = new URLSearchParams({
    pat: ctx.pat,
    environment: ctx.environment,
  });
  // Connect directly to Express server (port 3001) for SSE to bypass Vite proxy buffering
  const sseBase = window.location.port === '5173' ? 'http://localhost:3001' : '';
  const url = `${sseBase}/api/forward/sessions/${encodeURIComponent(sessionId)}/events/stream?${params.toString()}`;
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) {
    throw new ForwardApiError(res.status, await res.text());
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function processLines(lines: string[]) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        onEvent(JSON.parse(raw) as ForwardEvent);
      } catch {
        // skip malformed JSON
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    processLines(lines);
  }
  // Process any remaining data in buffer after stream ends
  if (buffer.trim()) {
    processLines([buffer]);
  }
}

// ─── Schedules (Forward API) ───────────────────────────────────────

export interface ForwardSchedule {
  id: string;
  type?: 'schedule';
  name: string;
  description?: string;
  identity_id: string;
  template_id: string;
  environment_id: string;
  status: 'active' | 'paused';
  paused_reason?: { type: string } | null;
  trigger_policy: {
    type: 'cron' | 'once' | 'interval' | 'manual';
    expression?: string;
    timezone?: string;
    upcoming_runs_at?: string[];
    last_run_at?: string | null;
  };
  execution?: {
    session_mode?: 'new_session' | 'reuse_session';
    max_concurrent_runs?: number;
    max_attempts?: number;
    timeout_ms?: number;
  };
  initial_events?: Array<{ type: string; content?: string | Array<{ type: string; text: string }> }>;
  sinks?: Array<{ type: string; channel_id?: string; channel_user_external_id?: string }>;
  metadata?: Record<string, unknown>;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ForwardScheduleRun {
  id: string;
  schedule_id: string;
  identity_id: string;
  template_id: string;
  session_id?: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  trigger_context?: { type: 'schedule' | 'manual'; scheduled_at?: string };
  error?: { type: string } | null;
  error_message?: string | null;
  result_payload?: string | null;
  push_sink?: string | null;
  push_status?: 'pending' | 'succeeded' | 'failed' | 'skipped';
  push_finished_at?: string | null;
  attempt?: number;
  triggered_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  created_at?: string;
}

export interface CreateScheduleInput {
  name: string;
  description?: string;
  identity_id: string;
  template_id: string;
  environment_id: string;
  initial_events: Array<{ type: string; content: string }>;
  trigger_policy?: { type: string; expression?: string; timezone?: string } | null;
  execution?: { session_mode?: string; max_concurrent_runs?: number; timeout_ms?: number };
}

export async function listSchedules(ctx: ForwardContext, identityId: string) {
  return forwardRequest<Page<ForwardSchedule>>(ctx, 'GET', '/schedules', undefined, {
    identity_id: identityId,
    include_archived: false,
    limit: 50,
  });
}

export async function createSchedule(ctx: ForwardContext, input: CreateScheduleInput) {
  return forwardRequest<ForwardSchedule>(ctx, 'POST', '/schedules', input);
}

export async function getSchedule(ctx: ForwardContext, scheduleId: string) {
  return forwardRequest<ForwardSchedule>(ctx, 'GET', `/schedules/${encodeURIComponent(scheduleId)}`);
}

export async function updateSchedule(ctx: ForwardContext, scheduleId: string, input: Partial<CreateScheduleInput>) {
  return forwardRequest<ForwardSchedule>(ctx, 'POST', `/schedules/${encodeURIComponent(scheduleId)}`, input);
}

export async function archiveSchedule(ctx: ForwardContext, scheduleId: string) {
  return forwardRequest<ForwardSchedule>(ctx, 'POST', `/schedules/${encodeURIComponent(scheduleId)}/archive`);
}

export async function runSchedule(ctx: ForwardContext, scheduleId: string) {
  return forwardRequest<ForwardScheduleRun>(ctx, 'POST', `/schedules/${encodeURIComponent(scheduleId)}/run`);
}

export async function pauseSchedule(ctx: ForwardContext, scheduleId: string) {
  return forwardRequest<ForwardSchedule>(ctx, 'POST', `/schedules/${encodeURIComponent(scheduleId)}/pause`);
}

export async function unpauseSchedule(ctx: ForwardContext, scheduleId: string) {
  return forwardRequest<ForwardSchedule>(ctx, 'POST', `/schedules/${encodeURIComponent(scheduleId)}/unpause`);
}

export async function listScheduleRuns(ctx: ForwardContext, identityId: string, scheduleId?: string) {
  return forwardRequest<Page<ForwardScheduleRun>>(ctx, 'GET', '/schedule_runs', undefined, {
    identity_id: identityId,
    ...(scheduleId ? { schedule_id: scheduleId } : {}),
    limit: 20,
  });
}

export async function getScheduleRun(ctx: ForwardContext, runId: string) {
  return forwardRequest<ForwardScheduleRun>(ctx, 'GET', `/schedule_runs/${encodeURIComponent(runId)}`);
}

// ─── Memory Stores (Cloud API) ─────────────────────────────────────

export interface MemoryEntry {
  id: string;
  type: 'memory';
  store_id: string;
  path: string;
  size: number;
  content_sha256: string;
  version: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export async function listMemoryEntries(ctx: ForwardContext, storeId: string) {
  return cloudRequest<Page<MemoryEntry>>(ctx, 'GET', `/memory_stores/${encodeURIComponent(storeId)}/memories`, undefined, {
    limit: 100,
  });
}

export async function getMemoryEntry(ctx: ForwardContext, storeId: string, entryId: string) {
  return cloudRequest<MemoryEntry & { content?: string }>(ctx, 'GET', `/memory_stores/${encodeURIComponent(storeId)}/memories/${encodeURIComponent(entryId)}`);
}

// ─── Channels (Forward API) ────────────────────────────────────────

export type ChannelType = 'wechat' | 'wecom' | 'feishu' | 'dingtalk';
export type BindingStatus = 'unbound' | 'bound' | 'expired';

export interface ForwardChannel {
  id: string;
  type: 'channel';
  identity_id: string;
  template_id: string;
  channel_type: ChannelType;
  name: string;
  enabled: boolean;
  binding_status: BindingStatus;
  channel_config?: {
    credentials?: Record<string, unknown>;
    response_options?: {
      include_tool_calls?: boolean;
      include_thinking?: boolean;
    };
  };
  created_at?: string;
  updated_at?: string;
}

export interface ForwardQrSession {
  session_key: string;
  channel_id: string;
  channel_type: ChannelType;
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'denied' | 'error';
  qr_code_content?: string;
  qr_code_image_base64?: string;
  expires_at?: string;
  poll_interval_seconds?: number;
  err_code?: string | null;
  err_msg?: string | null;
}

export async function listChannels(ctx: ForwardContext, identityId?: string) {
  return forwardRequest<Page<ForwardChannel>>(ctx, 'GET', '/channels', undefined, {
    ...(identityId ? { identity_id: identityId } : {}),
    limit: 50,
  });
}

export async function createChannel(
  ctx: ForwardContext,
  input: {
    identity_id: string;
    template_id: string;
    channel_type: ChannelType;
    name?: string;
    enabled?: boolean;
    channel_config?: {
      credentials?: Record<string, unknown>;
      response_options?: { include_tool_calls?: boolean; include_thinking?: boolean };
    };
  },
) {
  return forwardRequest<ForwardChannel>(ctx, 'POST', '/channels', input);
}

export async function getChannel(ctx: ForwardContext, channelId: string) {
  return forwardRequest<ForwardChannel>(ctx, 'GET', `/channels/${encodeURIComponent(channelId)}`);
}

export async function updateChannel(
  ctx: ForwardContext,
  channelId: string,
  input: {
    name?: string;
    identity_id?: string;
    template_id?: string;
    enabled?: boolean;
    channel_config?: {
      credentials?: Record<string, unknown>;
      response_options?: { include_tool_calls?: boolean; include_thinking?: boolean };
    };
  },
) {
  return forwardRequest<ForwardChannel>(ctx, 'POST', `/channels/${encodeURIComponent(channelId)}`, input);
}

export async function createQrSession(ctx: ForwardContext, channelId: string) {
  return forwardRequest<ForwardQrSession>(ctx, 'POST', `/channels/${encodeURIComponent(channelId)}/qr_sessions`, {});
}

export async function getQrSession(ctx: ForwardContext, sessionKey: string) {
  return forwardRequest<ForwardQrSession>(ctx, 'GET', `/qr_sessions/${encodeURIComponent(sessionKey)}`);
}

export async function deleteChannel(ctx: ForwardContext, channelId: string) {
  return forwardRequest<{ id: string; deleted: boolean }>(ctx, 'DELETE', `/channels/${encodeURIComponent(channelId)}`);
}
