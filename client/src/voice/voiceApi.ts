import { ForwardApiError, forwardRequest, type ForwardContext } from '../forwardApi';

export const REALTIME_VOICES = [
  { id: 'longanqian', name: '默认' },
  { id: 'longanlingxin', name: '龙安灵心' },
  { id: 'longanlingxi', name: '龙安灵希' },
  { id: 'longanxiaoxin', name: '龙安小昕' },
  { id: 'longanlufeng', name: '龙安鲁风' },
] as const;
export type RealtimeVoice = typeof REALTIME_VOICES[number]['id'];
export interface RealtimeConfig { audio: { output: { voice: string } } }
export function readRealtimeVoice(config: unknown): string | null {
  const voice = (config as RealtimeConfig | null)?.audio?.output?.voice;
  return typeof voice === 'string' && voice.trim() ? voice : null;
}
export function realtimeVoiceName(voice: string): string {
  return REALTIME_VOICES.find((item) => item.id === voice)?.name ?? voice;
}
export interface RealtimeConversation { id: string; type: 'voice.conversation'; status: 'ready'; config: RealtimeConfig; title?: string | null; metadata?: Record<string, unknown>; created_at?: string; updated_at?: string }
export interface RealtimeHistoryEvent { id: string; type: string; role?: 'user' | 'assistant'; status: string; text?: string; work_id?: string; objective?: string; result?: string; error?: { code: string }; occurred_at: string; turn_id?: string; user_message_event_id?: string }
export interface RealtimeConversationHistory { conversation: { id: string; title?: string | null; initialization_status: 'initializing' | 'ready' | 'failed'; config?: RealtimeConfig; metadata?: Record<string, unknown>; created_at?: string; updated_at?: string }; events: RealtimeHistoryEvent[]; page: { next_before: string | null; has_more: boolean } }
export interface RealtimeHistoryOptions { limit?: number; before?: string; types?: 'message,work' }

export async function getVoiceProxyCapability() {
  const response = await fetch('/api/health');
  const data = await response.json().catch(() => null) as { voiceRealtimeProxy?: { enabled?: boolean } } | null;
  if (!response.ok) throw new ForwardApiError(response.status, 'Voice proxy capability check failed');
  return data?.voiceRealtimeProxy?.enabled === true;
}

export function createRealtimeConversation(ctx: ForwardContext, input: { templateId: string; identityId: string; title?: string; voice?: RealtimeVoice; idempotencyKey: string }) {
  return forwardRequest<RealtimeConversation>(ctx, 'POST', '/realtime/conversations', {
    template_id: input.templateId,
    identity_id: input.identityId,
    title: input.title || 'Voice Session',
    ...(input.voice ? { config: { audio: { output: { voice: input.voice } } } } : {}),
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
