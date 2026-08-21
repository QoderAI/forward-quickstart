import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildChannelCredentials,
  channelTypesForEnvironment,
  deleteCloudEnvironment,
  deleteCloudSkill,
  deleteCloudVault,
  deleteForwardFile,
  downloadCloudFile,
  ForwardApiError,
  getCloudFile,
  getMemoryEntry,
  getTeamsCallbackUrl,
  listResourceCatalog,
  listEvents,
  listMemoryEntries,
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

describe('memory store endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('lists memories through the Forward API and normalizes size fields', async () => {
    let requestUrl = '';
    let requestBody: { path?: string; method?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        data: [{
          id: 'mem_1',
          type: 'memory',
          memory_store_id: 'memstore_1',
          path: 'notes.md',
          content_size_bytes: 42,
          content_sha256: 'sha',
          version: 1,
        }],
        has_more: false,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'sat_test', environment: 'cn-prod' };
    const page = await listMemoryEntries(ctx, 'memstore_1');

    expect(requestUrl).toBe('/api/forward/request');
    expect(requestBody).toMatchObject({
      method: 'GET',
      path: '/memory_stores/memstore_1/memories',
    });
    expect(page.data[0]).toMatchObject({
      memory_store_id: 'memstore_1',
      store_id: 'memstore_1',
      size: 42,
    });
  });

  test('gets memory content through the Forward API', async () => {
    let requestUrl = '';
    let requestBody: { path?: string; method?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'mem_1',
        type: 'memory',
        memory_store_id: 'memstore_1',
        path: 'notes.md',
        content: 'hello',
        content_size_bytes: 5,
        content_sha256: 'sha',
        version: 1,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'sat_test', environment: 'cn-prod' };
    const entry = await getMemoryEntry(ctx, 'memstore_1', 'mem_1');

    expect(requestUrl).toBe('/api/forward/request');
    expect(requestBody).toMatchObject({
      method: 'GET',
      path: '/memory_stores/memstore_1/memories/mem_1',
    });
    expect(entry.content).toBe('hello');
    expect(entry.size).toBe(5);
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

describe('file endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('reads file metadata through Forward first', async () => {
    let requestUrl = '';
    let requestBody: { path?: string; method?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'file_1',
        type: 'file',
        filename: 'demo.png',
        size_bytes: 12,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'sat_test', environment: 'cn-prod' };
    await getCloudFile(ctx, 'file_1');

    expect(requestUrl).toBe('/api/forward/request');
    expect(requestBody).toMatchObject({ method: 'GET', path: '/files/file_1' });
  });

  test('falls back to Cloud for Cloud-only file artifacts after a Forward 404', async () => {
    const requests: Array<{ url: string; body: { path?: string; method?: string } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(input), body });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'file_1',
        type: 'file',
        filename: 'artifact.png',
        size_bytes: 12,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-prod' };
    await getCloudFile(ctx, 'file_1');

    expect(requests.map((request) => request.url)).toEqual(['/api/forward/request', '/api/cloud/request']);
    expect(requests.map((request) => request.body.path)).toEqual(['/files/file_1', '/files/file_1']);
  });

  test('downloads files through Forward first', async () => {
    let requestBody: { path?: string; method?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ url: 'https://example.test/file' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'sat_test', environment: 'cn-prod' };
    await downloadCloudFile(ctx, 'file_1');

    expect(requestBody).toMatchObject({ method: 'GET', path: '/files/file_1/content' });
  });

  test('falls back to Cloud for PAT file downloads after a Forward 404', async () => {
    const requests: Array<{ url: string; body: { path?: string; method?: string } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(input), body });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'resource not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ url: 'https://example.test/file' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-prod', authMode: 'pat' };
    const resp = await downloadCloudFile(ctx, 'file_1');

    expect(resp.url).toBe('https://example.test/file');
    expect(requests.map((request) => request.url)).toEqual(['/api/forward/request', '/api/cloud/request']);
    expect(requests.map((request) => request.body.path)).toEqual(['/files/file_1/content', '/files/file_1/content']);
  });

  test('does not fall back to Cloud for service account file downloads', async () => {
    const requests: Array<{ url: string; body: { path?: string; method?: string } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(input), body });
      return new Response(JSON.stringify({ error: { message: 'resource not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'sat_test', environment: 'cn-prod', authMode: 'service-account' };
    await expect(downloadCloudFile(ctx, 'file_1')).rejects.toMatchObject({
      status: 404,
      message: 'resource not found',
    } satisfies Partial<ForwardApiError>);

    expect(requests.map((request) => request.url)).toEqual(['/api/forward/request']);
    expect(requests[0].body).toMatchObject({ method: 'GET', path: '/files/file_1/content' });
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

  test('maps Teams app, tenant, and secret credentials', () => {
    expect(buildChannelCredentials('teams', 'app-id', 'client-secret', 'tenant-id')).toEqual({
      app_id: 'app-id',
      tenant_id: 'tenant-id',
      client_secret: 'client-secret',
    });
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

describe('channelTypesForEnvironment', () => {
  test('offers Teams only in the global environment', () => {
    expect(channelTypesForEnvironment('global-prod')).toContain('teams');
    expect(channelTypesForEnvironment('cn-prod')).not.toContain('teams');
  });
});

describe('getTeamsCallbackUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('uses the Global production endpoint by default', () => {
    vi.stubEnv('VITE_TEAMS_CALLBACK_URL', '');
    expect(getTeamsCallbackUrl()).toBe('https://api.qoder.com/channels/teams/messages');
  });

  test('uses the configured endpoint override', () => {
    vi.stubEnv('VITE_TEAMS_CALLBACK_URL', 'https://gateway.example.com/channels/teams/messages');
    expect(getTeamsCallbackUrl()).toBe('https://gateway.example.com/channels/teams/messages');
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
