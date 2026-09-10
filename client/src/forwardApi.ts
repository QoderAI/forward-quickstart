export const DEFAULT_FORWARD_ENVIRONMENT_ID = 'env_019ef4d7c6c9742fa028eeed7ec232b5';

export type ForwardApiEnvironment = 'cn-prod' | 'global-prod';

export interface ForwardContext {
  // Active bearer token for the selected login mode. In PAT mode this is the
  // PAT; in Service Account mode this is the exchanged Service Account Token.
  pat: string;
  environment: ForwardApiEnvironment;
  authMode?: 'pat' | 'service-account';
}

export interface ForwardIdentity {
  id: string;
  external_id: string;
  name: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

export type ForwardTemplateModel = string | {
  id?: string;
  effort?: string;
  context_window?: number;
  [key: string]: unknown;
};

export type TemplateResourceBindings = Record<string, { enabled: boolean }>;

// A single entry in the multiagent roster. `type: 'self'` delegates to the
// coordinator itself; `type: 'agent'` references another Managed Agent by id.
export interface MultiagentAgentEntry {
  type: 'self' | 'agent';
  id?: string;
  version?: number | string;
  name?: string;
}

export interface MultiagentConfig {
  type: 'coordinator';
  agents: MultiagentAgentEntry[];
}

export interface ForwardTemplate {
  id: string;
  name: string;
  description?: string;
  status: string;
  model: ForwardTemplateModel;
  system?: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
  skills?: unknown[];
  multiagent?: MultiagentConfig | null;
  environment_id?: string;
  vaults?: TemplateResourceBindings;
  vault_ids?: TemplateResourceBindings | string[];
  files?: unknown;
  environment_variables?: unknown;
}

export type ForwardResourceType = 'skill' | 'file' | 'environment' | 'vault' | 'memory_store';

export interface ForwardResource {
  id: string;
  type: ForwardResourceType;
  owner_type: string;
  owner_id: string;
  icon_url?: string | null;
  binding_info?: { agent_template_count?: number };
  name?: string;
  description?: string;
  status?: string;
  version?: number | null;
  resource_spec?: Record<string, unknown>;
}

export interface CreateTemplateInput {
  name?: string;
  description?: string;
  model: ForwardTemplateModel;
  system: string;
  tools: unknown[];
  mcp_servers: unknown[];
  skills: unknown[];
  multiagent?: MultiagentConfig | null;
  environment_id: string;
  vault_ids: TemplateResourceBindings;
  files: TemplateResourceBindings;
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
  // Credit consumption. `credits` is the field that reconciles with the
  // /usage/identities aggregate; `total_credits` (what the docs recommend) is
  // only sporadically present and drifts, so treat it as a fallback. Both may be
  // absent when the billing module is off. See credits.ts for the details.
  usage?: { credits?: number | null; total_credits?: number | null };
  metadata?: Record<string, unknown>;
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
  'user.tool_confirmation',
  'user.question_answer',
  'user.custom_tool_result',
  'agent.message',
  'agent.thinking',
  'agent.ask_user_question',
  'agent.tool_use',
  'agent.custom_tool_use',
  'agent.mcp_tool_use',
  'agent.tool_result',
  'agent.custom_tool_result',
  'agent.mcp_tool_result',
  'session.status_idle',
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

export interface ForwardRequestOptions {
  idempotencyKey?: string;
}

export async function forwardRequest<T>(
  ctx: ForwardContext,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, unknown>,
  options: ForwardRequestOptions = {},
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
        ? options.idempotencyKey || `fw-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function canUseCloudFileFallback(ctx: ForwardContext) {
  return ctx.authMode !== 'service-account';
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
  // Migrated to Forward layer (POST /api/v1/forward/environments).
  return forwardRequest<CloudEnvironment>(ctx, 'POST', '/environments', {
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
  // Neither layer actually returns `type` on a model object (verified live),
  // so it stays optional to match reality.
  type?: 'model';
  display_name: string;
  source?: string;
  is_enabled?: boolean;
  is_new?: boolean;
  price_factor?: number;
  efforts?: string[];
  default_effort?: string;
  default_context_window?: number;
  available_context_windows?: number[];
}

export async function listCloudModels(ctx: ForwardContext) {
  // Migrated to Forward: /forward/models was 404 at the time of the original
  // audit but is now available and equivalent to the cloud layer — same 15 model
  // ids, same field set, identical values once the `efforts` array ordering is
  // normalised (verified live).
  return forwardRequest<{ data: CloudModel[]; has_more: boolean }>(ctx, 'GET', '/models');
}

export async function listCloudEnvironments(ctx: ForwardContext) {
  return forwardRequest<{ data: CloudEnvironment[] }>(ctx, 'GET', '/environments', undefined, {
    limit: 50,
  });
}

export async function getCloudEnvironment(ctx: ForwardContext, envId: string) {
  return forwardRequest<CloudEnvironment>(ctx, 'GET', `/environments/${encodeURIComponent(envId)}`);
}

export async function updateCloudEnvironment(
  ctx: ForwardContext,
  envId: string,
  input: { name?: string; description?: string; config?: Record<string, unknown> },
) {
  return forwardRequest<CloudEnvironment>(ctx, 'POST', `/environments/${encodeURIComponent(envId)}`, input);
}

export async function archiveCloudEnvironment(ctx: ForwardContext, envId: string) {
  return forwardRequest<CloudEnvironment>(ctx, 'POST', `/environments/${encodeURIComponent(envId)}/archive`);
}

export async function deleteCloudEnvironment(ctx: ForwardContext, envId: string) {
  return forwardRequest<{ id: string; type: string }>(ctx, 'DELETE', `/environments/${encodeURIComponent(envId)}`);
}

// ─── Skills (Cloud API) ────────────────────────────────────────────

// ─── Skills (Forward layer) ────────────────────────────────────────
// Forward returns the skill name as `display_title` (there is no `name` field);
// `name` is kept optional here only for backward-compat with older callers.
export interface CloudSkill {
  id: string;
  type: 'skill';
  name?: string;
  display_title?: string;
  description?: string;
  source?: string;
  latest_version?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export async function listCloudSkills(ctx: ForwardContext) {
  return forwardRequest<{ data: CloudSkill[] }>(ctx, 'GET', '/skills', undefined, { limit: 50 });
}

export async function getCloudSkill(ctx: ForwardContext, skillId: string) {
  return forwardRequest<CloudSkill>(ctx, 'GET', `/skills/${encodeURIComponent(skillId)}`);
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

  // Forward-layer multipart upload (server forwards to /api/v1/forward/skills).
  const uploadRes = await fetch('/api/forward/upload', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
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
  return forwardRequest<CloudSkill>(ctx, 'PUT', `/skills/${encodeURIComponent(skillId)}`, body);
}

export async function deleteCloudSkill(ctx: ForwardContext, skillId: string) {
  return forwardRequest<{ id: string; type: string }>(ctx, 'DELETE', `/skills/${encodeURIComponent(skillId)}`);
}

// ─── Files (Forward-first, Cloud fallback) ─────────────────────────
//
// Service Account Tokens cannot read the Cloud file layer, so user-uploaded
// files must go through Forward. Some older agent-generated artifacts may still
// be Cloud-only for PAT users, so arbitrary read paths fall back to Cloud on a
// Forward 404.

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
  return forwardRequest<{ data: CloudFile[] }>(ctx, 'GET', '/files', undefined, { limit: 50 });
}

export async function getCloudFile(ctx: ForwardContext, fileId: string) {
  const path = `/files/${encodeURIComponent(fileId)}`;
  try {
    return await forwardRequest<CloudFile>(ctx, 'GET', path);
  } catch (err) {
    if (canUseCloudFileFallback(ctx) && err instanceof ForwardApiError && err.status === 404) {
      return cloudRequest<CloudFile>(ctx, 'GET', path);
    }
    throw err;
  }
}

export async function uploadCloudFile(
  ctx: ForwardContext,
  input: { file: File; name?: string; metadata?: Record<string, unknown>; purpose?: string },
) {
  const uploadForm = new FormData();
  uploadForm.append('pat', ctx.pat);
  uploadForm.append('environment', ctx.environment);
  uploadForm.append('path', '/files');
  uploadForm.append('file', input.file);
  if (input.name) uploadForm.append('name', input.name);
  if (input.metadata) uploadForm.append('metadata', JSON.stringify(input.metadata));
  // purpose=session_resource is undocumented on Forward but verified live: without
  // it the file comes back downloadable:false and /content 403s. Keep sending it.
  if (input.purpose) uploadForm.append('purpose', input.purpose);

  // Forward-layer multipart upload (server forwards to /api/v1/forward/files).
  // Safe because the result is readable from both layers.
  const res = await fetch('/api/forward/upload', {
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

// Signed download URL for an arbitrary file id.
export async function downloadCloudFile(ctx: ForwardContext, fileId: string) {
  const path = `/files/${encodeURIComponent(fileId)}/content`;
  try {
    return await forwardRequest<{ url: string; expires_at?: string }>(ctx, 'GET', path);
  } catch (err) {
    if (canUseCloudFileFallback(ctx) && err instanceof ForwardApiError && err.status === 404) {
      return cloudRequest<{ url: string; expires_at?: string }>(ctx, 'GET', path);
    }
    throw err;
  }
}

export async function deleteCloudFile(ctx: ForwardContext, fileId: string) {
  const path = `/files/${encodeURIComponent(fileId)}`;
  try {
    return await forwardRequest<{ id: string; type: string }>(ctx, 'DELETE', path);
  } catch (err) {
    if (canUseCloudFileFallback(ctx) && err instanceof ForwardApiError && err.status === 404) {
      return cloudRequest<{ id: string; type: string }>(ctx, 'DELETE', path);
    }
    throw err;
  }
}

/** Delete a user-managed Forward file. Agent-generated artifacts still use deleteCloudFile. */
export async function deleteForwardFile(ctx: ForwardContext, fileId: string) {
  return forwardRequest<{ id: string; type: string }>(ctx, 'DELETE', `/files/${encodeURIComponent(fileId)}`);
}

// ─── Vaults (Cloud API) ────────────────────────────────────────────

// ─── Vaults (Forward layer) ────────────────────────────────────────
// Migrated from the cloud layer: Vaults are now first-class in Forward and
// scoped to the identity/PAT. Paths are unchanged; only the transport flips to
// forwardRequest (→ /api/v1/forward/vaults). Forward has no vault update
// endpoint (returns 501), but the app doesn't use one. `archive` is undocumented
// on Forward but verified live.
export interface CloudVault {
  id: string;
  type: 'vault';
  display_name: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export async function listCloudVaults(ctx: ForwardContext) {
  return forwardRequest<{ data: CloudVault[] }>(ctx, 'GET', '/vaults', undefined, { limit: 50 });
}

export async function getCloudVault(ctx: ForwardContext, vaultId: string) {
  return forwardRequest<CloudVault>(ctx, 'GET', `/vaults/${encodeURIComponent(vaultId)}`);
}

export async function createCloudVault(ctx: ForwardContext, input: { display_name: string; metadata?: Record<string, unknown> }) {
  return forwardRequest<CloudVault>(ctx, 'POST', '/vaults', {
    display_name: input.display_name,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function updateCloudVault(
  ctx: ForwardContext,
  vaultId: string,
  input: { display_name?: string; metadata?: Record<string, unknown> },
) {
  return forwardRequest<CloudVault>(ctx, 'POST', `/vaults/${encodeURIComponent(vaultId)}`, input);
}

export async function archiveCloudVault(ctx: ForwardContext, vaultId: string) {
  return forwardRequest<CloudVault>(ctx, 'POST', `/vaults/${encodeURIComponent(vaultId)}/archive`);
}

export async function deleteCloudVault(ctx: ForwardContext, vaultId: string) {
  return forwardRequest<{ id: string; type: string }>(ctx, 'DELETE', `/vaults/${encodeURIComponent(vaultId)}`);
}

// ─── Vault Credentials (Forward layer) ─────────────────────────────
// Nested under a vault, migrated to forwardRequest. Credential id prefix is
// vcred_; auth secrets are never echoed and display_name comes back empty.

export interface CloudCredential {
  id: string;
  type: 'vault_credential';
  vault_id: string;
  auth: { type: string; mcp_server_url?: string; secret_name?: string };
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export async function listCloudCredentials(ctx: ForwardContext, vaultId: string) {
  return forwardRequest<{ data: CloudCredential[] }>(ctx, 'GET', `/vaults/${encodeURIComponent(vaultId)}/credentials`, undefined, { limit: 50 });
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
  return forwardRequest<CloudCredential>(ctx, 'POST', `/vaults/${encodeURIComponent(vaultId)}/credentials`, {
    auth,
    ...(metadata ? { metadata } : {}),
  });
}

export async function deleteCloudCredential(ctx: ForwardContext, vaultId: string, credentialId: string) {
  return forwardRequest<{ id: string; type: string }>(ctx, 'DELETE', `/vaults/${encodeURIComponent(vaultId)}/credentials/${encodeURIComponent(credentialId)}`);
}

export interface ForwardServiceAccountToken {
  type: 'service_account_token';
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: string;
  auth_token_id: string;
  service_account_id: string;
  credential_id: string;
  subject_type: 'admin' | 'identity';
  identity_id?: string;
}

export async function createServiceAccountToken(
  ctx: ForwardContext,
  input: { identityId?: string; ttlSeconds?: number; metadata?: Record<string, unknown> } = {},
) {
  const path = input.identityId
    ? `/identities/${encodeURIComponent(input.identityId)}/service_account_tokens`
    : '/service_account_tokens';
  return forwardRequest<ForwardServiceAccountToken>(ctx, 'POST', path, {
    ...(input.ttlSeconds ? { ttl_seconds: input.ttlSeconds } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
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

export async function getIdentity(ctx: ForwardContext, identityId: string) {
  return forwardRequest<ForwardIdentity>(ctx, 'GET', `/identities/${encodeURIComponent(identityId)}`);
}

export async function deleteIdentity(ctx: ForwardContext, identityId: string) {
  return forwardRequest<{ id: string; type: string; deleted: boolean }>(ctx, 'DELETE', `/identities/${encodeURIComponent(identityId)}`);
}

export interface ForwardAccessToken {
  id: string;
  type: 'access_token';
  identity_id: string;
  token_type: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export async function listAccessTokens(ctx: ForwardContext, identityId: string) {
  return forwardRequest<Page<ForwardAccessToken>>(ctx, 'GET', `/identities/${encodeURIComponent(identityId)}/access_tokens`, undefined, { limit: 50 });
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

export async function deleteAccessToken(ctx: ForwardContext, identityId: string, tokenId: string) {
  return forwardRequest<{ id: string; type: string; deleted: boolean }>(ctx, 'DELETE', `/identities/${encodeURIComponent(identityId)}/access_tokens/${encodeURIComponent(tokenId)}`);
}

export async function getTemplate(ctx: ForwardContext, templateId: string) {
  return forwardRequest<ForwardTemplate>(ctx, 'GET', `/templates/${encodeURIComponent(templateId)}`);
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
    model: normalizeTemplateModelInput(input?.model),
    system: input?.system?.trim() || '你是 Forward quickstart 测试助手，请用简洁、准确的方式回答用户。',
    tools: input?.tools ?? [],
    mcp_servers: input?.mcp_servers ?? [],
    skills: input?.skills ?? [],
    ...(input?.multiagent ? { multiagent: input.multiagent } : {}),
    vault_ids: input?.vault_ids ?? {},
    files: input?.files ?? {},
    environment_variables: input?.environment_variables ?? {},
    metadata: { created_by: 'forward-quickstart' },
  });
}

function normalizeTemplateModelInput(model: ForwardTemplateModel | undefined): ForwardTemplateModel {
  if (typeof model === 'string') return model.trim() || 'ultimate';
  if (model && typeof model === 'object') {
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    return { ...model, id: id || 'ultimate' };
  }
  return 'ultimate';
}

export async function updateTemplate(ctx: ForwardContext, templateId: string, input: Partial<CreateTemplateInput>) {
  // Forward Template update uses merge-patch semantics: only send changed fields.
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  if (input.model !== undefined) body.model = input.model;
  if (input.system !== undefined) body.system = input.system;
  if (input.environment_id !== undefined) body.environment_id = input.environment_id;
  if (input.tools !== undefined) body.tools = input.tools;
  if (input.mcp_servers !== undefined) body.mcp_servers = input.mcp_servers;
  if (input.skills !== undefined) body.skills = input.skills;
  if (input.vault_ids !== undefined) body.vault_ids = input.vault_ids;
  if (input.files !== undefined) body.files = input.files;
  if (input.environment_variables !== undefined) body.environment_variables = input.environment_variables;
  // multiagent uses replace semantics: send the field to replace it, or null to clear.
  if (input.multiagent !== undefined) body.multiagent = input.multiagent ?? null;
  return forwardRequest<ForwardTemplate>(ctx, 'POST', `/templates/${encodeURIComponent(templateId)}`, body);
}

export async function cloneTemplate(ctx: ForwardContext, templateId: string, name?: string) {
  return forwardRequest<ForwardTemplate>(
    ctx,
    'POST',
    `/templates/${encodeURIComponent(templateId)}/clone`,
    name?.trim() ? { name: name.trim() } : {},
  );
}

export async function archiveTemplate(ctx: ForwardContext, templateId: string) {
  return forwardRequest<ForwardTemplate>(
    ctx,
    'POST',
    `/templates/${encodeURIComponent(templateId)}/archive`,
  );
}

// Managed-layer Agent, the unit referenced by a multiagent roster entry.
// Each Forward Template compiles to a Managed Agent; the roster `id` must be
// an agent ID (agent_xxx), not a template ID.
export interface ManagedAgent {
  id: string;
  name: string;
  version: number;
  model?: string | { id?: string };
  status?: string;
}

// List Managed Agents so the template editor can offer them as multiagent
// roster candidates. Forward Templates don't expose their backing agent ID,
// so the editor lists agents by name and stores the agent ID in the roster.
export async function listManagedAgents(ctx: ForwardContext) {
  return cloudRequest<Page<ManagedAgent>>(ctx, 'GET', '/agents', undefined, {
    limit: 100,
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

function lifecycleResource(type: Exclude<ForwardResourceType, 'memory_store'>, value: unknown): ForwardResource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const resource = value as Record<string, unknown>;
  if (typeof resource.id !== 'string' || !resource.id) return null;
  const displayName = [resource.display_title, resource.display_name, resource.filename, resource.name]
    .find((item): item is string => typeof item === 'string' && !!item);
  return {
    id: resource.id,
    type,
    owner_type: typeof resource.owner_type === 'string' ? resource.owner_type : 'identity',
    owner_id: typeof resource.owner_id === 'string'
      ? resource.owner_id
      : typeof resource.identity_id === 'string' ? resource.identity_id : '',
    ...(typeof resource.icon_url === 'string' || resource.icon_url === null ? { icon_url: resource.icon_url } : {}),
    ...(resource.binding_info && typeof resource.binding_info === 'object'
      ? { binding_info: resource.binding_info as { agent_template_count?: number } }
      : {}),
    ...(displayName ? { name: displayName } : {}),
    ...(typeof resource.description === 'string' ? { description: resource.description } : {}),
    status: resource.archived_at ? 'archived' : typeof resource.status === 'string' ? resource.status : 'active',
    resource_spec: resource,
  };
}

/** Resource-management list. Mirrors the Forward console lifecycle endpoints. */
export async function listResourceCatalog(ctx: ForwardContext, type: ForwardResourceType) {
  if (type === 'memory_store') return listResources(ctx, type);
  const response = type === 'skill'
    ? await listCloudSkills(ctx)
    : type === 'file'
      ? await listCloudFiles(ctx)
      : type === 'environment'
        ? await listCloudEnvironments(ctx)
        : await listCloudVaults(ctx);
  const data = response.data
    .map((item) => lifecycleResource(type, item))
    .filter((item): item is ForwardResource => item !== null);
  return { data, has_more: false } satisfies Page<ForwardResource>;
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

// Paged/date-filtered session query, used by the usage panel's credit ledger.
//
// Deliberately separate from listSessions() above: that one is on the chat hot
// path with its own hardcoded params, and widening it risked regressing the
// conversation flow. Note the API takes RFC 3339 strings here, unlike the usage
// endpoints below which take Unix millis.
export async function listSessionsPage(
  ctx: ForwardContext,
  opts: {
    identityIds?: string | string[];
    templateId?: string;
    createdAtGte?: string;
    createdAtLte?: string;
    limit?: number;
    afterId?: string;
    includeArchived?: boolean;
    order?: 'asc' | 'desc';
  } = {},
) {
  const identityIds = Array.isArray(opts.identityIds) ? opts.identityIds.join(',') : opts.identityIds;
  const page = await forwardRequest<Page<ForwardSession>>(ctx, 'GET', '/sessions', undefined, {
    ...(identityIds ? { identity_ids: identityIds } : {}),
    ...(opts.templateId ? { template_id: opts.templateId } : {}),
    ...(opts.createdAtGte ? { 'created_at[gte]': opts.createdAtGte } : {}),
    ...(opts.createdAtLte ? { 'created_at[lte]': opts.createdAtLte } : {}),
    ...(opts.afterId ? { after_id: opts.afterId } : {}),
    include_archived: opts.includeArchived ?? true,
    order: opts.order ?? 'desc',
    limit: Math.min(opts.limit ?? 100, 100),
  });
  return page;
}

// ─── Usage / credits ──────────────────────────────────────────────
// Both endpoints take start_time/end_time as Unix MILLISECONDS (start inclusive,
// end exclusive) and reject any span over 31 days with
// 400 "time range must not exceed 31 days". `credits` is null when credit lookup
// is unavailable, which is not the same as zero.

export interface IdentityUsageRow {
  type: string;
  identity_id: string;
  session_count: number;
  duration_seconds: number;
  credits: number | null;
  session_ids?: string[];
}

export interface TemplateUsageRow {
  type: string;
  template_id: string;
  active_identities: number;
  session_count: number;
  duration_seconds: number;
  credits: number | null;
}

interface UsageEnvelope<T> {
  type: string;
  start_time: number;
  end_time: number;
  data: T[];
}

export async function listIdentityUsage(
  ctx: ForwardContext,
  opts: { startMs: number; endMs: number; identityId?: string },
) {
  return forwardRequest<UsageEnvelope<IdentityUsageRow>>(ctx, 'GET', '/usage/identities', undefined, {
    start_time: Math.floor(opts.startMs),
    end_time: Math.floor(opts.endMs),
    ...(opts.identityId ? { identity_id: opts.identityId } : {}),
  });
}

export async function listTemplateUsage(
  ctx: ForwardContext,
  opts: { startMs: number; endMs: number; identityId?: string; templateId?: string },
) {
  return forwardRequest<UsageEnvelope<TemplateUsageRow>>(ctx, 'GET', '/usage/templates', undefined, {
    start_time: Math.floor(opts.startMs),
    end_time: Math.floor(opts.endMs),
    ...(opts.identityId ? { identity_id: opts.identityId } : {}),
    ...(opts.templateId ? { template_id: opts.templateId } : {}),
  });
}

export async function createSession(
  ctx: ForwardContext,
  identityId: string,
  templateId: string,
  title: string,
  fileIds?: string[],
) {
  return forwardRequest<ForwardSession>(ctx, 'POST', '/sessions', {
    identity_id: identityId,
    template_id: templateId,
    title,
    incremental_streaming_enabled: true,
    metadata: { created_by: 'forward-quickstart' },
    // Mount chat attachments into the agent workspace at session creation.
    ...(fileIds && fileIds.length > 0
      ? { resources: fileIds.map((file_id) => ({ type: 'file', file_id })) }
      : {}),
  });
}

// Mount an already-uploaded file into an EXISTING session's workspace.
// Migrated to the Forward layer (POST /api/v1/forward/sessions/{id}/resources,
// verified live). The mount_path must live under /data/workspace — the default
// /mnt/session/uploads path never materializes into the agent sandbox.
export async function addSessionFileResource(
  ctx: ForwardContext,
  sessionId: string,
  input: { file_id: string; mount_path: string },
) {
  return forwardRequest<{ id: string; type: string; file_id: string; mount_path: string }>(
    ctx,
    'POST',
    `/sessions/${encodeURIComponent(sessionId)}/resources`,
    { type: 'file', file_id: input.file_id, mount_path: input.mount_path },
  );
}

export interface SessionFileResource {
  type: string;
  file_id?: string;
  mount_path?: string | null;
}

// List a session's mounted resources. Stays on the CLOUD layer: Forward returns
// 405 for GET /sessions/{id}/resources, and its GET /files?scope_id= filter does
// not reflect session-mounted files (verified). Used to map an attachment
// marker's mount_path back to its file id for previews after a history reload.
export async function listSessionResources(ctx: ForwardContext, sessionId: string) {
  return cloudRequest<Page<SessionFileResource>>(
    ctx,
    'GET',
    `/sessions/${encodeURIComponent(sessionId)}/resources`,
  );
}

export async function getSession(ctx: ForwardContext, sessionId: string) {
  return forwardRequest<ForwardSession>(ctx, 'GET', `/sessions/${encodeURIComponent(sessionId)}`);
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

export async function sendToolConfirmation(
  ctx: ForwardContext,
  sessionId: string,
  toolUseId: string,
  result: 'allow' | 'deny',
  denyMessage?: string,
) {
  return forwardRequest<{ data: ForwardEvent[] }>(
    ctx,
    'POST',
    `/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      events: [{
        type: 'user.tool_confirmation',
        tool_use_id: toolUseId,
        result,
        ...(result === 'deny' && denyMessage?.trim() ? { deny_message: denyMessage.trim() } : {}),
      }],
    },
  );
}

export async function sendQuestionAnswer(
  ctx: ForwardContext,
  sessionId: string,
  questionUseId: string,
  answers: string[][],
  dismissed = false,
) {
  return forwardRequest<{ data: ForwardEvent[] }>(
    ctx,
    'POST',
    `/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      events: [{
        type: 'user.question_answer',
        question_use_id: questionUseId,
        ...(dismissed ? { dismissed: true } : { answers }),
      }],
    },
  );
}

export async function sendCustomToolResult(
  ctx: ForwardContext,
  sessionId: string,
  customToolUseId: string,
  content: string,
) {
  return forwardRequest<{ data: ForwardEvent[] }>(
    ctx,
    'POST',
    `/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      events: [{
        type: 'user.custom_tool_result',
        custom_tool_use_id: customToolUseId,
        content: [{ type: 'text', text: content }],
      }],
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
    environment: ctx.environment,
  });
  // Connect directly to Express server (port 3001) for SSE to bypass Vite proxy buffering
  const sseBase = window.location.port === '5173' ? 'http://localhost:3001' : '';
  const url = `${sseBase}/api/forward/sessions/${encodeURIComponent(sessionId)}/events/stream?${params.toString()}`;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    Authorization: `Bearer ${ctx.pat}`,
  };
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

export async function deleteSchedule(ctx: ForwardContext, scheduleId: string) {
  return forwardRequest<{ id: string; type: string; deleted: boolean }>(ctx, 'DELETE', `/schedules/${encodeURIComponent(scheduleId)}`);
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

// ─── Memory Stores (Forward API) ───────────────────────────────────

export interface MemoryEntry {
  id: string;
  type: 'memory';
  memory_store_id: string;
  store_id?: string;
  path: string;
  size: number;
  content_size_bytes?: number;
  content_sha256: string;
  version: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export async function listMemoryEntries(ctx: ForwardContext, storeId: string) {
  const page = await forwardRequest<Page<MemoryEntry>>(ctx, 'GET', `/memory_stores/${encodeURIComponent(storeId)}/memories`, undefined, {
    limit: 100,
  });
  return { ...page, data: page.data.map(normalizeMemoryEntry) };
}

export async function getMemoryEntry(ctx: ForwardContext, storeId: string, entryId: string) {
  const entry = await forwardRequest<MemoryEntry & { content?: string }>(ctx, 'GET', `/memory_stores/${encodeURIComponent(storeId)}/memories/${encodeURIComponent(entryId)}`);
  return normalizeMemoryEntry(entry);
}

function normalizeMemoryEntry<T extends MemoryEntry>(entry: T): T {
  return {
    ...entry,
    size: entry.size ?? entry.content_size_bytes ?? 0,
    store_id: entry.store_id ?? entry.memory_store_id,
  };
}

// ─── Channels (Forward API) ────────────────────────────────────────

export type ChannelType = 'wechat' | 'wecom' | 'feishu' | 'lark' | 'dingtalk' | 'slack' | 'teams';
export type BindingStatus = 'unbound' | 'bound' | 'expired';
export type IdentityResolutionMode = 'fixed' | 'pairing';

export interface ForwardChannel {
  id: string;
  type: 'channel';
  identity_id: string | null;
  template_id: string | null;
  identity_resolution: { mode: IdentityResolutionMode };
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
    identity_id?: string;
    template_id?: string;
    identity_resolution?: { mode: IdentityResolutionMode };
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

export function buildChannelCredentials(
  channelType: ChannelType,
  key: string,
  secret: string,
  tenantId?: string,
): Record<string, string> {
  switch (channelType) {
    case 'feishu':
    case 'lark':
      return { app_id: key, app_secret: secret };
    case 'slack':
      return { app_token: key, bot_token: secret };
    case 'dingtalk':
      return { client_id: key, client_secret: secret };
    case 'teams':
      return { app_id: key, tenant_id: tenantId ?? '', client_secret: secret };
    case 'wecom':
      return { bot_id: key, secret };
    default:
      // wechat 仅支持扫码绑定，不使用直连密钥
      return {};
  }
}

export const CHANNEL_MAX_COUNTS: Record<ChannelType, number> = {
  wechat: 3,
  wecom: 5,
  dingtalk: 5,
  feishu: 5,
  lark: 5,
  slack: 5,
  teams: 5,
};

const DEFAULT_TEAMS_CALLBACK_URL = 'https://api.qoder.com/channels/teams/messages';

export function getTeamsCallbackUrl(): string {
  return import.meta.env.VITE_TEAMS_CALLBACK_URL?.trim() || DEFAULT_TEAMS_CALLBACK_URL;
}

export function channelTypesForEnvironment(environment: ForwardApiEnvironment): ChannelType[] {
  return environment === 'global-prod'
    ? ['wechat', 'wecom', 'dingtalk', 'feishu', 'lark', 'slack', 'teams']
    : ['wechat', 'wecom', 'dingtalk', 'feishu'];
}

// QR 扫码 confirmed 只代表扫码动作完成；渠道真正可处理上行消息需要
// binding_status=bound。绑定落库可能是异步的，这里轮询等待最终结果。
export async function waitForChannelBinding(
  ctx: ForwardContext,
  channelId: string,
  opts?: { attempts?: number; intervalMs?: number },
): Promise<ForwardChannel> {
  const attempts = Math.max(1, opts?.attempts ?? 4);
  const intervalMs = Math.max(0, opts?.intervalMs ?? 1500);
  let channel = await getChannel(ctx, channelId);
  for (let i = 1; i < attempts && channel.binding_status === 'unbound'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    channel = await getChannel(ctx, channelId);
  }
  return channel;
}

// ─── Batches (Forward API) ──────────────────────────────────

export type BatchStatus =
  | 'validating' | 'queued' | 'processing'
  | 'cancelling' | 'expiring' | 'finalizing'
  | 'completed' | 'failed' | 'cancelled' | 'expired';

export type BatchCompletionWindow = '24h' | '48h' | '72h';

export interface BatchRequestCounts {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  expired: number;
}

export interface ForwardBatch {
  id: string;                        // 前缀 batch_
  object: 'batch';
  status: BatchStatus;
  input_file_id: string;
  output_file_id?: string;           // 终态后才出现
  error_file_id?: string;            // 有失败行时才出现
  completion_window: BatchCompletionWindow;
  created_at: string;                // RFC 3339
  expires_at: string;
  request_counts: BatchRequestCounts;
  usage: null;                       // v1 预留
  metadata?: Record<string, unknown>;
  error_message?: string;            // 仅 failed 状态
}

// JSONL 行结构（前端构建/校验用）
export interface BatchInputLine {
  custom_id: string;
  template_id: string;
  identity_id: string;
  body: Record<string, unknown>;
}

export const BATCH_TERMINAL_STATUSES: ReadonlySet<BatchStatus> =
  new Set(['completed', 'failed', 'cancelled', 'expired']);

export async function listBatches(
  ctx: ForwardContext,
  opts?: { status?: BatchStatus; limit?: number; afterId?: string },
) {
  return forwardRequest<Page<ForwardBatch>>(ctx, 'GET', '/batches', undefined, {
    ...(opts?.status ? { status: opts.status } : {}),
    ...(opts?.afterId ? { after_id: opts.afterId } : {}),
    limit: opts?.limit ?? 20,
  });
}

export async function createBatch(
  ctx: ForwardContext,
  input: {
    input_file_id: string;
    completion_window: BatchCompletionWindow;
    metadata?: Record<string, unknown>;
  },
) {
  return forwardRequest<ForwardBatch>(ctx, 'POST', '/batches', input);
}

export async function getBatch(ctx: ForwardContext, batchId: string) {
  return forwardRequest<ForwardBatch>(ctx, 'GET', `/batches/${encodeURIComponent(batchId)}`);
}

export async function cancelBatch(ctx: ForwardContext, batchId: string) {
  return forwardRequest<ForwardBatch>(ctx, 'POST', `/batches/${encodeURIComponent(batchId)}/cancel`);
}

export async function getBatchOutput(ctx: ForwardContext, batchId: string) {
  return forwardRequest<{ url: string; expires_at?: string }>(ctx, 'GET', `/batches/${encodeURIComponent(batchId)}/output`);
}
