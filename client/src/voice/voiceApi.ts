import { ForwardApiError, forwardRequest, type ForwardContext } from '../forwardApi';

export interface TemplateRealtimeConfig { type: 'template_realtime_config'; template_id: string; enabled: boolean }
export interface RealtimeConversation { id: string; object: 'voice.conversation'; status: 'initializing' | 'ready' | 'failed'; title?: string | null; metadata?: Record<string, unknown>; created_at?: string; updated_at?: string }
export interface RealtimeHistoryEvent { id: string; type: string; role?: 'user' | 'assistant'; status: string; text?: string; work_id?: string; objective?: string; result?: string; error?: { code: string }; occurred_at: string; turn_id?: string; user_message_event_id?: string }
export interface RealtimeConversationHistory { conversation: { id: string; title?: string | null; initialization_status: 'initializing' | 'ready' | 'failed'; metadata?: Record<string, unknown>; created_at?: string; updated_at?: string }; events: RealtimeHistoryEvent[]; page: { next_before: string | null; has_more: boolean } }
export interface RealtimeHistoryOptions { limit?: number; before?: string; types?: 'message,work' }

export async function getVoiceProxyCapability() {
  const response = await fetch('/api/health');
  const data = await response.json().catch(() => null) as { voiceRealtimeProxy?: { enabled?: boolean } } | null;
  if (!response.ok) throw new ForwardApiError(response.status, 'Voice proxy capability check failed');
  return data?.voiceRealtimeProxy?.enabled === true;
}

export function getTemplateRealtimeConfig(ctx: ForwardContext, templateId: string) {
  return forwardRequest<TemplateRealtimeConfig>(ctx, 'GET', `/realtime/templates/${encodeURIComponent(templateId)}`);
}

export function createRealtimeConversation(ctx: ForwardContext, input: { templateId: string; identityId: string; title?: string; idempotencyKey: string }) {
  return forwardRequest<RealtimeConversation>(ctx, 'POST', '/realtime/conversations', {
    template_id: input.templateId,
    identity_id: input.identityId,
    title: input.title || 'Voice Session',
  }, undefined, { idempotencyKey: input.idempotencyKey });
}

export function getRealtimeConversationHistory(ctx: ForwardContext, conversationId: string, options: RealtimeHistoryOptions = {}) {
  return forwardRequest<RealtimeConversationHistory>(ctx, 'GET', `/realtime/conversations/${encodeURIComponent(conversationId)}/history`, undefined, { ...options });
}

export async function getCompleteRealtimeConversationHistory(ctx: ForwardContext, conversationId: string, options: RealtimeHistoryOptions = {}) {
  let before = options.before;
  const seenCursors = new Set(before ? [before] : []);
  let conversation: RealtimeConversationHistory['conversation'] | undefined;
  const events: RealtimeHistoryEvent[] = [];
  while (true) {
    const page = await getRealtimeConversationHistory(ctx, conversationId, { ...options, ...(before ? { before } : {}) });
    conversation ??= page.conversation;
    events.push(...page.events);
    const next = page.page.has_more ? page.page.next_before : null;
    if (!next || seenCursors.has(next)) return { conversation, events, page: page.page };
    seenCursors.add(next);
    before = next;
  }
}

export async function requestVoiceConnectionKey(ctx: ForwardContext, conversationId: string) {
  const response = await fetch('/api/voice/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pat: ctx.pat, environment: ctx.environment, conversation_id: conversationId }),
  });
  const data = await response.json().catch(() => null) as { connection_key?: string; expires_in_ms?: number; error?: { message?: string } } | null;
  if (!response.ok || !data?.connection_key) throw new ForwardApiError(response.status, data?.error?.message || 'Voice connection key request failed');
  return { connection_key: data.connection_key, expires_in_ms: Number(data.expires_in_ms || 0) };
}
