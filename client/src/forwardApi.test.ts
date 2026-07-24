import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildChannelCredentials,
  listEvents,
  waitForChannelBinding,
  type ForwardChannel,
  type ForwardContext,
} from './forwardApi';

describe('listEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('passes event type filters using the supported types query parameter', async () => {
    let requestBody: any;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [], has_more: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-pre' };
    await listEvents(ctx, 'sess_123');

    expect(requestBody.query).toEqual({
      limit: 100,
      order: 'desc',
      types: [
        'user.message',
        'agent.message',
        'agent.thinking',
        'agent.tool_use',
        'agent.custom_tool_use',
        'agent.mcp_tool_use',
        'agent.tool_result',
        'agent.custom_tool_result',
        'agent.mcp_tool_result',
      ].join(','),
    });
    expect(requestBody.query).not.toHaveProperty('types[]');
  });
});

describe('buildChannelCredentials', () => {
  test('maps fields for feishu', () => {
    expect(buildChannelCredentials('feishu', 'cli_x', 's3cr3t')).toEqual({ app_id: 'cli_x', app_secret: 's3cr3t' });
  });

  test('maps fields for dingtalk', () => {
    expect(buildChannelCredentials('dingtalk', 'ding-key', 'ding-secret')).toEqual({ client_id: 'ding-key', client_secret: 'ding-secret' });
  });

  test('maps fields for wecom', () => {
    expect(buildChannelCredentials('wecom', 'bot-1', 'bot-secret')).toEqual({ bot_id: 'bot-1', secret: 'bot-secret' });
  });

  test('returns no credentials for wechat (QR-only channel)', () => {
    expect(buildChannelCredentials('wechat', 'ignored', 'ignored')).toEqual({});
  });
});

describe('waitForChannelBinding', () => {
  const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-prod' };

  function channelWith(bindingStatus: ForwardChannel['binding_status']): ForwardChannel {
    return {
      id: 'channel_1',
      type: 'channel',
      identity_id: 'idn_1',
      template_id: 'tmpl_1',
      channel_type: 'wechat',
      name: 'test',
      enabled: false,
      binding_status: bindingStatus,
    };
  }

  function stubChannelResponses(responses: ForwardChannel[]) {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const channel = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(channel), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return () => calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns immediately when the channel is already bound', async () => {
    const callCount = stubChannelResponses([channelWith('bound')]);
    const channel = await waitForChannelBinding(ctx, 'channel_1', { attempts: 3, intervalMs: 0 });
    expect(channel.binding_status).toBe('bound');
    expect(callCount()).toBe(1);
  });

  test('keeps polling while unbound until the binding takes effect', async () => {
    const callCount = stubChannelResponses([channelWith('unbound'), channelWith('unbound'), channelWith('bound')]);
    const channel = await waitForChannelBinding(ctx, 'channel_1', { attempts: 5, intervalMs: 0 });
    expect(channel.binding_status).toBe('bound');
    expect(callCount()).toBe(3);
  });

  test('returns the latest channel when binding never completes, so callers can show a pending state', async () => {
    const callCount = stubChannelResponses([channelWith('unbound')]);
    const channel = await waitForChannelBinding(ctx, 'channel_1', { attempts: 3, intervalMs: 0 });
    expect(channel.binding_status).toBe('unbound');
    expect(callCount()).toBe(3);
  });

  test('stops polling when the binding expires', async () => {
    const callCount = stubChannelResponses([channelWith('unbound'), channelWith('expired')]);
    const channel = await waitForChannelBinding(ctx, 'channel_1', { attempts: 5, intervalMs: 0 });
    expect(channel.binding_status).toBe('expired');
    expect(callCount()).toBe(2);
  });
});
