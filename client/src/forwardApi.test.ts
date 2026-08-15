import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildChannelCredentials,
  deleteCloudEnvironment,
  deleteCloudSkill,
  deleteCloudVault,
  deleteForwardFile,
  listResourceCatalog,
  listEvents,
  updateCloudEnvironment,
  updateCloudSkill,
  updateCloudVault,
  uploadCloudSkill,
  waitForChannelBinding,
  type ForwardChannel,
  type ForwardContext,
} from './forwardApi';

describe('listEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('passes event type filters using the supported types query parameter', async () => {
    let requestBody: { query?: Record<string, unknown> } = {};
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
      ].join(','),
    });
    expect(requestBody.query).not.toHaveProperty('types[]');
  });
});

describe('resource lifecycle endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each([
    ['skill', '/skills', { id: 'skill_1', display_title: 'Demo Skill', description: 'demo' }],
    ['file', '/files', { id: 'file_1', filename: 'demo.txt', size_bytes: 12 }],
    ['environment', '/environments', { id: 'env_1', name: 'Demo Env', config: {} }],
    ['vault', '/vaults', { id: 'vault_1', display_name: 'Demo Vault' }],
  ] as const)('lists %s resources through its Forward lifecycle endpoint', async (type, path, item) => {
    let requestBody: { path?: string; method?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [item], has_more: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-prod' };
    const result = await listResourceCatalog(ctx, type);

    expect(requestBody).toMatchObject({ method: 'GET', path });
    expect(result.data[0]).toMatchObject({ id: item.id, type, status: 'active' });
    expect(result.data[0].resource_spec).toMatchObject(item);
  });

  test('adds an idempotency key to Forward skill multipart uploads', async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ id: 'skill_1', type: 'skill' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-prod' };
    await uploadCloudSkill(ctx, {
      name: 'Demo Skill',
      file: new File(['zip'], 'skill.zip', { type: 'application/zip' }),
    });

    expect(requestInit?.method).toBe('POST');
    expect((requestInit?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect((requestInit?.body as FormData).get('path')).toBe('/skills');
  });

  test.each([
    ['skill', deleteCloudSkill, '/skills/skill_1'],
    ['file', deleteForwardFile, '/files/file_1'],
    ['environment', deleteCloudEnvironment, '/environments/env_1'],
    ['vault', deleteCloudVault, '/vaults/vault_1'],
  ] as const)('deletes %s resources through its Forward lifecycle endpoint', async (type, remove, path) => {
    let requestBody: { path?: string; method?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: path.split('/').at(-1), type }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-prod' };
    await remove(ctx, path.split('/').at(-1)!);

    expect(requestBody).toMatchObject({ method: 'DELETE', path });
  });

  test.each([
    ['skill', updateCloudSkill, '/skills/skill_1', { name: 'Renamed' }],
    ['environment', updateCloudEnvironment, '/environments/env_1', { name: 'Renamed' }],
    ['vault', updateCloudVault, '/vaults/vault_1', { display_name: 'Renamed' }],
  ] as const)('updates %s resources through its Forward lifecycle endpoint', async (type, update, path, input) => {
    let requestBody: { path?: string; method?: string; body?: unknown } = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: path.split('/').at(-1), type }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-prod' };
    await update(ctx, path.split('/').at(-1)!, input);

    expect(requestBody).toMatchObject({ path, body: input });
    expect(requestBody.method).toBe(type === 'skill' ? 'PUT' : 'POST');
  });
});

describe('buildChannelCredentials', () => {
  test('maps fields for feishu', () => {
    expect(buildChannelCredentials('feishu', 'cli_x', 's3cr3t')).toEqual({ app_id: 'cli_x', app_secret: 's3cr3t' });
  });

  test('maps fields for lark and slack', () => {
    expect(buildChannelCredentials('lark', 'cli_lark', 'lark-secret')).toEqual({ app_id: 'cli_lark', app_secret: 'lark-secret' });
    expect(buildChannelCredentials('slack', 'xapp-token', 'xoxb-token')).toEqual({ app_token: 'xapp-token', bot_token: 'xoxb-token' });
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
