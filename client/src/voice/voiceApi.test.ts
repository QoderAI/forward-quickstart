import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ForwardContext } from '../forwardApi';
import { createRealtimeConversation, getCompleteRealtimeConversationHistory, getRealtimeConversationHistory, getTemplateRealtimeConfig, getVoiceProxyCapability, requestVoiceConnectionKey } from './voiceApi';

const ctx: ForwardContext = { pat: 'pat_secret', environment: 'global-prod' };

describe('voice API', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('uses Forward-relative realtime HTTP paths and stable idempotency', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 'conv_1', object: 'voice.conversation', status: 'ready', events: [], page: { has_more: false, next_before: null } }), { status: 200 });
    }));
    await getTemplateRealtimeConfig(ctx, 'tmpl_1');
    await createRealtimeConversation(ctx, { templateId: 'tmpl_1', identityId: 'idn_1', title: 'Voice Session', idempotencyKey: 'voice-create-1' });
    await getRealtimeConversationHistory(ctx, 'conv_1', { limit: 100, types: 'message,work' });
    expect(bodies[0]).toMatchObject({ environment: 'global-prod', method: 'GET', path: '/realtime/templates/tmpl_1' });
    expect(bodies[1]).toMatchObject({ method: 'POST', path: '/realtime/conversations', body: { identity_id: 'idn_1', template_id: 'tmpl_1', title: 'Voice Session' }, idempotencyKey: 'voice-create-1' });
    expect(bodies[2]).toMatchObject({ method: 'GET', path: '/realtime/conversations/conv_1/history', query: { limit: 100, types: 'message,work' } });
  });

  test('requests a local one-time websocket key', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/voice/connect');
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ connection_key: 'key_1', expires_in_ms: 30000 }), { status: 200 });
    }));
    expect(await requestVoiceConnectionKey(ctx, 'conv_1')).toEqual({ connection_key: 'key_1', expires_in_ms: 30000 });
    expect(body).toEqual({ pat: 'pat_secret', environment: 'global-prod', conversation_id: 'conv_1' });
  });

  test('reads the local voice proxy capability from health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      voiceRealtimeProxy: { enabled: false, localOnly: true },
    }), { status: 200 })));

    await expect(getVoiceProxyCapability()).resolves.toBe(false);
  });

  test('loads every realtime history page using next_before', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const before = (body.query as Record<string, unknown>).before;
      return new Response(JSON.stringify({
        conversation: { id: 'conv_1', initialization_status: 'ready' },
        events: [{ id: before ? 'evt_1' : 'evt_2', type: 'voice.user_message.completed', role: 'user', status: 'completed', text: before ? 'first' : 'second', occurred_at: before ? '2026-08-15T00:00:00Z' : '2026-08-15T00:00:01Z' }],
        page: before ? { has_more: false, next_before: null } : { has_more: true, next_before: 'cursor-1' },
      }), { status: 200 });
    }));

    const history = await getCompleteRealtimeConversationHistory(ctx, 'conv_1', { limit: 100, types: 'message,work' });

    expect(history.events.map((event) => event.id)).toEqual(['evt_2', 'evt_1']);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].query).toEqual({ limit: 100, types: 'message,work' });
    expect(bodies[1].query).toEqual({ limit: 100, types: 'message,work', before: 'cursor-1' });
  });
});
