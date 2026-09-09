import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ForwardContext } from '../forwardApi';
import { createRealtimeConversation, getCompleteRealtimeConversationHistory, getRealtimeConversationHistory, getVoiceProxyCapability } from './voiceApi';

const ctx: ForwardContext = { pat: 'pat_secret', environment: 'global-prod' };

describe('voice API', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('preserves invalid voice codes and request IDs for actionable startup errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      request_id: 'req_voice',
      error: { code: 'invalid_voice', message: 'Voice is unavailable' },
    }), { status: 400 })));
    await expect(createRealtimeConversation(ctx, {
      templateId: 'tmpl_1', identityId: 'idn_1', idempotencyKey: 'invalid-voice',
    })).rejects.toMatchObject({ status: 400, code: 'invalid_voice', requestId: 'req_voice' });
  });

  test('uses Forward-relative realtime HTTP paths and stable idempotency', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 'conv_1', type: 'voice.conversation', status: 'ready', events: [], page: { has_more: false, next_before: null } }), { status: 200 });
    }));
    await createRealtimeConversation(ctx, { templateId: 'tmpl_1', identityId: 'idn_1', title: 'Voice Session', idempotencyKey: 'voice-create-1' });
    await getRealtimeConversationHistory(ctx, 'conv_1', { limit: 100, types: 'message,work' });
    expect(bodies[0]).toMatchObject({ method: 'POST', path: '/realtime/conversations', body: { identity_id: 'idn_1', template_id: 'tmpl_1', title: 'Voice Session' }, idempotencyKey: 'voice-create-1' });
    expect(bodies[1]).toMatchObject({ method: 'GET', path: '/realtime/conversations/conv_1/history', query: { limit: 100, types: 'message,work' } });
  });

  test('sends each preset voice in conversation config and preserves the create operation on retry', async () => {
    const { REALTIME_VOICES } = await import('./voiceApi');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 'conv_1', type: 'voice.conversation', status: 'ready', config: { audio: { output: { voice: 'longanlingxin' } } } }), { status: 201 });
    }));
    for (const voice of REALTIME_VOICES) {
      const input = { templateId: 'tmpl_1', identityId: 'idn_1', voice: voice.id, idempotencyKey: `create-${voice.id}` };
      const result = await createRealtimeConversation(ctx, input);
      await createRealtimeConversation(ctx, input);
      expect(bodies.at(-1)).toEqual(bodies.at(-2));
      expect(bodies.at(-1)).toMatchObject({ body: { config: { audio: { output: { voice: voice.id } } } }, idempotencyKey: input.idempotencyKey });
      expect(result.type).toBe('voice.conversation');
      expect(result.config.audio.output.voice).toBe('longanlingxin');
    }
  });

  test('omits config when requesting the server default', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).body).not.toHaveProperty('config');
      return new Response('{}', { status: 201 });
    }));
    await createRealtimeConversation(ctx, { templateId: 'tmpl_1', identityId: 'idn_1', idempotencyKey: 'default-1' });
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
