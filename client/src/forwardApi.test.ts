import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';
import {
  buildChannelCredentials,
  channelTypesForEnvironment,
  createTemplate,
  updateTemplate,
  forwardRequest,
  getSession,
  cancelSession,
  streamEvents,
  listTemplates,
  listResources,
  listCloudEnvironments,
  listCloudSkills,
  listCloudVaults,
  listCloudFiles,
  listSchedules,
  listChannels,
  listSessions,
  listSessionsPage,
  listBatches,
  listBatchTasks,
  uploadCloudFile,
  type ForwardEvent,
  deleteCloudEnvironment,
  deleteCloudSkill,
  deleteCloudVault,
  deleteForwardFile,
  downloadCloudFile,
  previewCloudFile,
  ForwardApiError,
  getCloudFile,
  getMemoryEntry,
  getTeamsCallbackUrl,
  listResourceCatalog,
  listEvents,
  listRecentEvents,
  listMemoryEntries,
  updateCloudEnvironment,
  updateCloudSkill,
  updateCloudVault,
  uploadCloudSkill,
  waitForChannelBinding,
  type ForwardChannel,
  startSessionPolling,
  type ForwardContext,
} from './forwardApi';

describe('cancelSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('distinguishes accepted cancellation from no active turn by HTTP status', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'canceling' }, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const ctx = { pat: 'test-token', environment: 'cn-prod' as const };
    const signal = new AbortController().signal;
    expect(await cancelSession(ctx, 'session', signal)).toBe(true);
    expect(await cancelSession(ctx, 'session', signal)).toBe(false);
    expect(fetch.mock.calls[0][1].signal).toBe(signal);
  });
});

describe('login credential privacy', () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const authMode of ['pat', 'service-account']) {
    test(`${authMode} credentials are hidden by default, including saved logins`, () => {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => key === 'forward_quickstart_auth'
          ? JSON.stringify({ authMode, pat: 'test_token', externalId: 'test_user', apiEnvironment: 'global-prod' })
          : null,
      });
      const html = renderToStaticMarkup(createElement(App));
      const placeholder = authMode === 'pat' ? '粘贴你的 Personal Access Token' : '粘贴你的 Service Account Key';
      const credentialInput = html.match(/<input[^>]+>/g)?.find(input => input.includes(placeholder));
      expect(credentialInput).toContain('type="password"');
      expect(credentialInput).toContain('autoComplete="off"');
      expect(html).toContain(`aria-label="显示${authMode === 'pat' ? '访问令牌' : 'SA Key'}"`);
      expect(html).toContain('aria-pressed="false"');
    });
  }
});

describe('session polling', () => {
  let page: EventTarget & { visibilityState: string };
  let controller: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    controller = new AbortController();
    vi.stubGlobal('document', page);
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    controller.abort();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('polls every five seconds and stops on abort', async () => {
    const sync = vi.fn(async () => {});
    startSessionPolling(sync, controller.signal, vi.fn());
    await vi.advanceTimersByTimeAsync(4999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(15000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('pauses hidden pages and synchronizes immediately on return', async () => {
    page.visibilityState = 'hidden';
    const sync = vi.fn(async () => {});
    startSessionPolling(sync, controller.signal, vi.fn());
    await vi.advanceTimersByTimeAsync(15000);
    expect(sync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync).toHaveBeenCalledTimes(3);
  });

  test('does not overlap slow requests, including visibility changes', async () => {
    let complete!: () => void;
    const sync = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    startSessionPolling(sync, controller.signal, vi.fn());
    await vi.advanceTimersByTimeAsync(15000);
    page.dispatchEvent(new Event('visibilitychange'));
    expect(sync).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync).toHaveBeenCalledTimes(2);
    complete();
  });

  test('reports failures and continues polling', async () => {
    const error = new Error('temporary failure');
    const sync = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    startSessionPolling(sync, controller.signal, onError);
    await vi.advanceTimersByTimeAsync(10000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  test('removes visibility listeners and ignores late errors after stopping', async () => {
    let reject!: (error: Error) => void;
    const sync = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const onError = vi.fn();
    const stop = startSessionPolling(sync, controller.signal, onError);
    await vi.advanceTimersByTimeAsync(5000);
    stop();
    reject(new Error('late failure'));
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('listEvents', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('loads the latest page in descending order with a comma-separated type filter', async () => {
    const { requests } = stubPages([{ data: [], has_more: false }]);
    await listEvents(apiContext, 'sess /?');
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/sessions/sess%20%2F%3F/events' });
    expect(requests[0].query).toEqual({
      limit: 100,
      order: 'desc',
      type: [
        'user.message',
        'user.interrupt',
        'user.tool_confirmation',
        'user.question_answer',
        'user.tool_result',
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
        'agent.artifact_delivered',
        'span.model_request_end',
        'session.status_running',
        'session.status_idle',
        'session.status_terminated',
        'session.completed',
        'session.cancelled',
        'session.canceled',
        'session.error',
        'session.updated',
        'session.usage',
        'session.thread_created',
        'session.thread_status_running',
        'session.thread_status_idle',
        'session.thread_status_rescheduled',
        'session.thread_status_terminated',
        'agent.thread_message_sent',
        'agent.thread_message_received',
      ].join(','),
    });
  });

  test.each([
    [{ beforeId: 'cursor' }, 'before_id', 'desc', 'after_id'],
    [{ afterId: 'cursor' }, 'after_id', 'asc', 'before_id'],
  ] as const)('pairs %j with %s and %s order', async (opts, cursor, order, otherCursor) => {
    const page = { data: [], first_id: null, last_id: null, has_more: false };
    const { requests } = stubPages([page]);
    expect(await listEvents(apiContext, 'sess', opts)).toEqual(page);
    expect(requests[0].query).toMatchObject({ [cursor]: 'cursor', limit: 100, order });
    expect(requests[0].query).not.toHaveProperty(otherCursor);
  });

  test('rejects simultaneous before and after cursors without making a request', async () => {
    const { fetch } = stubPages([]);
    await expect(listEvents(apiContext, 'sess', { afterId: 'newer', beforeId: 'older' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_pagination' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('listRecentEvents', () => {
  afterEach(() => vi.unstubAllGlobals());

  const eventPage = (ids: string[], has_more: boolean) => ({
    data: ids.map(id => ({ id, type: 'agent.message', session_id: 'sess' })),
    first_id: ids[0] ?? null,
    last_id: ids.at(-1) ?? null,
    has_more,
  });

  test.each([undefined, 'known'])('returns the whole latest page without paging for knownId=%s', async knownId => {
    const latest = eventPage(['new', 'known', 'old'], true);
    const { fetch, requests } = stubPages([latest]);
    expect(await listRecentEvents(apiContext, 'sess', knownId)).toEqual(latest);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests[0].query).toMatchObject({ order: 'desc' });
    expect(requests[0].query).not.toHaveProperty('before_id');
  });

  test('recovers a gap of more than 100 events in API order and keeps the boundary page cursor', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => `evt_${201 - index}`);
    const latest = eventPage(ids.slice(0, 100), true);
    const middle = eventPage(ids.slice(99, 199), true); // Duplicate at the page boundary.
    const oldest = eventPage([...ids.slice(199), 'known', 'older-than-known'], true);
    const { fetch, requests } = stubPages([latest, middle, oldest]);
    const page = await listRecentEvents(apiContext, 'sess', 'known');
    expect(page.data.map(event => event.id)).toEqual([...ids, 'known', 'older-than-known']);
    expect(page).toMatchObject({ first_id: ids[0], last_id: 'older-than-known', has_more: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(requests.slice(1).map(({ query }) => query)).toEqual([
      expect.objectContaining({ before_id: latest.last_id, order: 'desc' }),
      expect.objectContaining({ before_id: middle.last_id, order: 'desc' }),
    ]);
    for (const { query } of requests) expect(query).not.toHaveProperty('after_id');
  });

  test('returns all reachable history when the known event was deleted, even if the final page is empty', async () => {
    const latest = eventPage(['new', 'newer-cursor'], true);
    const older = eventPage(['old', 'oldest'], true);
    const { fetch, requests } = stubPages([latest, older, eventPage([], false)]);
    const page = await listRecentEvents(apiContext, 'sess', 'deleted');
    expect(page).toEqual({ data: [...latest.data, ...older.data], first_id: 'new', last_id: 'oldest', has_more: false });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(requests.map(({ query }) => query.before_id)).toEqual([undefined, 'newer-cursor', 'oldest']);
  });

  test.each([
    [{ data: [], has_more: true }],
    [eventPage(['new'], true), { ...eventPage(['old'], true), last_id: null }],
  ])('rejects has_more without last_id instead of guessing a cursor', async (...pages) => {
    const { fetch } = stubPages(pages);
    await expect(listRecentEvents(apiContext, 'sess', 'known')).rejects.toMatchObject({
      status: 502, code: 'invalid_pagination_cursor', message: expect.stringContaining('has_more=true 但缺少分页游标 last_id'),
    });
    expect(fetch).toHaveBeenCalledTimes(pages.length);
  });

  test.each([['a', 'a'], ['a', 'b', 'a']])('rejects repeated or cyclic cursors: %s', async (...cursors) => {
    const { fetch } = stubPages(cursors.map(cursor => eventPage([cursor], true)));
    await expect(listRecentEvents(apiContext, 'sess', 'known')).rejects.toMatchObject({
      status: 502, code: 'invalid_pagination_cursor', message: expect.stringContaining('last_id 没有推进'),
    });
    expect(fetch).toHaveBeenCalledTimes(cursors.length);
  });

  test('forwards the signal to every page fetch and aborts a pending older-page request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(eventPage(['new'], true)))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    vi.stubGlobal('fetch', fetch);
    const pending = listRecentEvents(apiContext, 'sess', 'known', { signal: controller.signal });
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await failure;
    for (const [, init] of fetch.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('signal');
    }
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
      identity_resolution: { mode: 'fixed' },
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


describe('file previews', () => {
  afterEach(() => vi.unstubAllGlobals());
  test('PAT falls back to Cloud only on Forward 404 and passes auth mode', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? new Response(null, { status: 404 }) : new Response('image', { headers: { 'content-type': 'image/png' } });
    }));
    const blob = await previewCloudFile({ pat: 'pat', environment: 'cn-prod' }, 'a b');
    expect(await blob.text()).toBe('image');
    expect(calls[0]).toContain('/api/forward/files/a%20b/preview?');
    expect(calls[1]).toContain('/api/cloud/files/a%20b/preview?');
    expect(calls[1]).toContain('authMode=pat');
  });
  test.each([[401, 'pat'], [403, 'pat'], [500, 'pat'], [404, 'service-account']] as const)('does not widen access for %s in %s mode', async (status, authMode) => {
    const fetch = vi.fn(async () => new Response(null, { status })); vi.stubGlobal('fetch', fetch);
    await expect(previewCloudFile({ pat: 'token', environment: 'global-prod', authMode }, 'f1')).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

const apiContext: ForwardContext = { pat: 'private_token', environment: 'global-prod', authMode: 'service-account' };

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}

describe('HTTP error contract and cancellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test.each(['12', 'Wed, 25 Nov 2026 10:00:00 GMT'])('preserves raw Retry-After %s and structured error fields', async retryAfter => {
    const payload = { type: 'error', request_id: 'body-id', error: {
      type: 'invalid_request_error', code: 'invalid_event_cursor', param: 'Last-Event-ID', message: 'bad cursor',
    } };
    const raw = JSON.stringify(payload);
    const fetch = vi.fn(async () => new Response(raw, {
      status: 429, headers: { 'x-request-id': 'header-id', 'Retry-After': retryAfter },
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(forwardRequest(apiContext, 'POST', '/templates', {}, undefined, { idempotencyKey: 'fixed-key' }))
      .rejects.toMatchObject({
        name: 'ForwardApiError', status: 429, requestId: 'header-id', code: 'invalid_event_cursor',
        type: 'invalid_request_error', param: 'Last-Event-ID', retryAfter, raw,
        message: '[invalid_event_cursor] bad cursor (request id: header-id)',
      });
    expect(fetch).toHaveBeenCalledTimes(1); // Writes are never replayed.
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/forward/request');
    expect(url).not.toContain(apiContext.pat);
    expect(JSON.parse(String(init.body))).toMatchObject({ idempotencyKey: 'fixed-key' });
  });

  test.each([
    { request_id: 'request-id' },
    { requestId: 'request-id' },
    { error: { request_id: 'request-id' } },
    { error: { requestId: 'request-id' } },
  ])('keeps request IDs from the JSON envelope: %j', async payload => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload, 400)));
    await expect(forwardRequest(apiContext, 'GET', '/sessions')).rejects.toMatchObject({ requestId: 'request-id' });
  });

  test('keeps a flat error code/type/param and the legacy error constructor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      type: 'conflict_error', code: 'conflict', param: null, message: 'already running',
    }, 409)));
    await expect(forwardRequest(apiContext, 'GET', '/sessions')).rejects.toMatchObject({
      type: 'conflict_error', code: 'conflict', param: null, message: '[conflict] already running',
    });
    expect(new ForwardApiError(400, 'legacy', 'req', 'code')).toMatchObject({ status: 400, requestId: 'req', code: 'code' });
  });

  test('keeps non-JSON upstream responses without masking them with JSON parse errors', async () => {
    const raw = '<html>upstream unavailable</html>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 503 })));
    await expect(forwardRequest(apiContext, 'GET', '/templates')).rejects.toMatchObject({
      status: 503, raw, message: `Forward API error 503\n[原始响应] ${raw}`,
    });
  });

  test.each([
    ['skill upload', () => uploadCloudSkill(apiContext, { file: new File(['x'], 'skill.zip') })],
    ['file upload', () => uploadCloudFile(apiContext, { file: new File(['x'], 'file.txt') })],
    ['file preview', () => previewCloudFile(apiContext, 'file_1')],
  ] as const)('uses the same error envelope for %s', async (_name, request) => {
    const payload = { request_id: 'req', error: { type: 'permission_error', code: 'denied', param: 'file', message: 'no access' } };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload, 403, { 'Retry-After': '4' })));
    await expect(request()).rejects.toMatchObject({
      status: 403, type: 'permission_error', code: 'denied', param: 'file', requestId: 'req', retryAfter: '4', raw: JSON.stringify(payload),
    });
  });

  test('also preserves the error contract from the existing Cloud file fallback', async () => {
    const payload = { request_id: 'cloud-req', error: { type: 'api_error', code: 'unavailable', message: 'offline' } };
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'missing' } }, 404))
      .mockResolvedValueOnce(jsonResponse(payload, 503, { 'Retry-After': '2' }));
    vi.stubGlobal('fetch', fetch);
    await expect(getCloudFile({ ...apiContext, authMode: 'pat' }, 'file')).rejects.toMatchObject({
      status: 503, requestId: 'cloud-req', type: 'api_error', code: 'unavailable', retryAfter: '2', raw: JSON.stringify(payload),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('passes signal to fetch, never to the wire body, for getSession and forwardRequest', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty('signal');
      expect(body).not.toHaveProperty('idempotencyKey');
      return jsonResponse({ id: 'a b', status: 'running' });
    });
    vi.stubGlobal('fetch', fetch);
    await getSession(apiContext, 'a b', { signal: controller.signal });
    await forwardRequest(apiContext, 'GET', '/sessions', undefined, undefined, { signal: controller.signal });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).path).toBe('/sessions/a%20b');
  });

  test('cancels a pending getSession without misreporting success or retrying', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const request = getSession(apiContext, 'sess', { signal: controller.signal });
    const failure = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await failure;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function stubSse(chunks: Uint8Array[], close = true, headers: HeadersInit = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
  });
  const response = new Response(body, { headers });
  const reader = body.getReader();
  vi.spyOn(body, 'getReader').mockReturnValue(reader);
  const cancel = vi.spyOn(reader, 'cancel');
  const release = vi.spyOn(reader, 'releaseLock');
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  return { body, fetch, cancel, release };
}

function sseBytes(text: string) { return new TextEncoder().encode(text); }

describe('SSE frames and lifecycle', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { port: '5173' } }));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('decodes multiline CRLF frames and UTF-8 split at every byte without deduplicating delta IDs', async () => {
    const start = { id: 'json-id', type: 'event_start', session_id: 'sess', event: { id: 'json-id', type: 'agent.message' } };
    const delta = { id: 'json-id', type: 'event_delta', session_id: 'sess', delta: { content: { text: '你好' } } };
    const wire = `: heartbeat\r\nretry: 1000\r\nid: sse-id\r\nevent: event_start\r\ndata: ${JSON.stringify(start)}\r\n\r\n`
      + `id: sse-id\r\nevent: event_delta\r\ndata: {"id":"json-id","type":"event_delta",\r\ndata: "session_id":"sess","delta":{"content":{"text":"你好"}}}\r\n\r\n`
      + `id: sse-id\nevent: event_delta\ndata: ${JSON.stringify(delta)}\n\n`;
    const stream = stubSse(Array.from(sseBytes(wire), byte => Uint8Array.of(byte)));
    const events: ForwardEvent[] = [];
    const order: string[] = [];
    await streamEvents(apiContext, 'sess', event => { events.push(event); order.push(event.type); }, undefined, undefined, {
      onCursor: id => { order.push(id); },
    });
    expect(events).toEqual([start, delta, delta]);
    expect(order).toEqual(['event_start', 'sse-id', 'event_delta', 'sse-id', 'event_delta', 'sse-id']);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  test('does not promote a same-ID delta or an inherited cursor to a complete-event cursor', async () => {
    const wire = 'id: partial\ndata: {"id":"partial","type":"event_start"}\n\n'
      + 'id: partial\ndata: {"id":"partial","type":"event_delta"}\n\n'
      + 'data: {"id":"no-explicit-cursor","type":"session.usage"}\n\n'
      + 'id: partial\ndata: {"id":"partial","type":"agent.message"}\n\n';
    stubSse([sseBytes(wire)]);
    const onCompleteEventCursor = vi.fn();
    const onEvent = vi.fn();
    await streamEvents(apiContext, 'sess', onEvent, undefined, 'prior', { onCompleteEventCursor });
    expect(onEvent).toHaveBeenCalledTimes(4);
    expect(onCompleteEventCursor).toHaveBeenCalledExactlyOnceWith('partial', { id: 'partial', type: 'agent.message' });
  });

  test('parses lone-CR frames correctly at every possible chunk boundary', async () => {
    const wire = sseBytes('id: cursor\revent: agent.message\rdata: {"id":"json-id","content":"你好"}\r\r');
    for (let boundary = 1; boundary < wire.length; boundary += 1) {
      const stream = stubSse([wire.slice(0, boundary), wire.slice(boundary)]);
      const onEvent = vi.fn();
      const onCursor = vi.fn();
      await streamEvents(apiContext, 'sess', onEvent, undefined, undefined, { onCursor });
      expect(onEvent).toHaveBeenCalledExactlyOnceWith({ id: 'json-id', content: '你好' });
      expect(onCursor).toHaveBeenCalledExactlyOnceWith('cursor');
      expect(stream.body.locked).toBe(false);
    }
  });

  test('waits for a blank line before dispatching a frame', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const onEvent = vi.fn();
    const pending = streamEvents(apiContext, 'sess', onEvent);
    source.enqueue(sseBytes('data: {"id":"evt","type":"agent.message"}\n'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onEvent).not.toHaveBeenCalled();
    source.enqueue(sseBytes('\n'));
    source.close();
    await pending;
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  test('keeps SSE IDs independent of JSON IDs, inherits valid IDs, and honors empty ID resets', async () => {
    const wire = 'id: cursor\ndata: {"id":"one","type":"agent.message"}\n\n'
      + 'id: ignored\0id\ndata: {"id":"two","type":"agent.message"}\n\n'
      + 'id:\ndata: {"id":"three","type":"agent.message"}\n\n';
    stubSse([sseBytes(wire)]);
    const onCursor = vi.fn();
    const onEvent = vi.fn();
    await streamEvents(apiContext, 'sess', onEvent, undefined, undefined, { onCursor });
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onCursor.mock.calls.map(([id]) => id)).toEqual(['cursor', 'cursor', '']);
  });

  test('does not invent a cursor from JSON id or dispatch an incomplete EOF frame', async () => {
    stubSse([sseBytes('data: {"id":"json","type":"agent.message"}\n\ndata: {"id":"partial"}\n')]);
    const onEvent = vi.fn();
    const onCursor = vi.fn();
    await streamEvents(apiContext, 'sess', onEvent, undefined, undefined, { onCursor });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ id: 'json', type: 'agent.message' });
    expect(onCursor).not.toHaveBeenCalled();
  });

  test('ignores comments and malformed JSON without acknowledging a failed frame', async () => {
    stubSse([sseBytes(': heartbeat\n\nid: bad\ndata: {broken}\n\nid: good\ndata: {"id":"evt","type":"unknown.event"}\n\n')]);
    const onCursor = vi.fn();
    const onEvent = vi.fn();
    await streamEvents(apiContext, 'sess', onEvent, undefined, undefined, { onCursor });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ id: 'evt', type: 'unknown.event' });
    expect(onCursor).toHaveBeenCalledExactlyOnceWith('good');
  });

  test('a malformed frame cannot contaminate an id-less following frame cursor', async () => {
    stubSse([sseBytes('id: good\ndata: {"id":"one"}\n\nid: bad\ndata: {broken}\n\ndata: {"id":"two"}\n\n')]);
    const onCursor = vi.fn();
    await streamEvents(apiContext, 'sess', vi.fn(), undefined, undefined, { onCursor });
    expect(onCursor.mock.calls.map(([id]) => id)).toEqual(['good', 'good']);
  });

  test('only sends opt-in delta/filter parameters and the official thinking beta header', async () => {
    const stream = stubSse([]);
    await streamEvents(apiContext, 'sess /?', vi.fn(), undefined, 'resume-id', {
      eventDeltas: ['agent.message', 'agent.thinking'], includeThinking: false, includeToolCalls: true,
    });
    const [url, init] = stream.fetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/forward/sessions/sess%20%2F%3F/events/stream');
    expect(parsed.searchParams.getAll('event_deltas[]')).toEqual(['agent.message', 'agent.thinking']);
    expect(parsed.searchParams.get('include_thinking')).toBe('false');
    expect(parsed.searchParams.get('include_tool_calls')).toBe('true');
    expect(parsed.searchParams.get('authMode')).toBe('service-account');
    expect(url).not.toContain(apiContext.pat);
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${apiContext.pat}`, 'Last-Event-ID': 'resume-id',
      'X-Qoder-Beta': 'thinking-event-stream-delta-2026-07-20',
    });
  });

  test.each([undefined, {}, { eventDeltas: ['agent.message'] as Array<'agent.message'> }])('preserves default requests without a thinking opt-in: %j', async options => {
    vi.stubGlobal('window', { location: { port: '443' } });
    const stream = stubSse([]);
    await streamEvents(apiContext, 'sess', vi.fn(), undefined, undefined, options);
    const [url, init] = stream.fetch.mock.calls[0];
    const params = new URL(url, 'https://example.test').searchParams;
    expect(url.startsWith('/api/forward/')).toBe(true);
    expect(params.has('include_thinking')).toBe(false);
    expect(params.has('include_tool_calls')).toBe(false);
    expect(params.getAll('event_deltas[]')).toEqual(options?.eventDeltas ?? []);
    expect(init?.headers).not.toHaveProperty('X-Qoder-Beta');
    expect(init?.headers).not.toHaveProperty('Last-Event-ID');
  });

  test('advances onCursor only after an asynchronous event callback succeeds', async () => {
    stubSse([sseBytes('id: cursor\ndata: {"id":"evt","type":"event_delta"}\n\n')]);
    let finish!: () => void;
    const onEvent = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onCursor = vi.fn();
    const pending = streamEvents(apiContext, 'sess', onEvent, undefined, undefined, { onCursor });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onCursor).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(onCursor).toHaveBeenCalledExactlyOnceWith('cursor');
  });

  test.each(['sync', 'async', 'cursor'] as const)('propagates %s callback failures and cancels/releases the reader', async mode => {
    const stream = stubSse([sseBytes('id: cursor\ndata: {"id":"evt","type":"event_delta"}\n\n')], false);
    const failure = new Error('callback failed');
    const onCursor = vi.fn(() => { if (mode === 'cursor') throw failure; });
    const onEvent = vi.fn(() => {
      if (mode === 'sync') throw failure;
      if (mode === 'async') return Promise.reject(failure);
    });
    await expect(streamEvents(apiContext, 'sess', onEvent, undefined, undefined, { onCursor })).rejects.toBe(failure);
    expect(onCursor).toHaveBeenCalledTimes(mode === 'cursor' ? 1 : 0);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  test.each(['event: error\n', ''])('rejects SSE error envelopes instead of forwarding or acknowledging them: %j', async prefix => {
    const payload = { type: 'error', request_id: 'stream-req', error: {
      type: 'api_error', code: 'stream_failed', param: 'events', message: 'stream failure',
    } };
    const raw = JSON.stringify(payload);
    const stream = stubSse([sseBytes(`id: failed\n${prefix}data: ${raw}\n\n`)], false, { 'Retry-After': '5' });
    const onEvent = vi.fn();
    const onCursor = vi.fn();
    await expect(streamEvents(apiContext, 'sess', onEvent, undefined, undefined, { onCursor })).rejects.toMatchObject({
      status: 502, type: 'api_error', code: 'stream_failed', param: 'events', requestId: 'stream-req', retryAfter: '5', raw,
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onCursor).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  test('does not swallow a non-JSON error frame', async () => {
    const stream = stubSse([sseBytes('event: error\ndata: upstream disconnected\n\n')], false);
    const onEvent = vi.fn();
    await expect(streamEvents(apiContext, 'sess', onEvent)).rejects.toMatchObject({ status: 502, raw: 'upstream disconnected' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.body.locked).toBe(false);
  });

  test('retains HTTP handshake errors and does not reconnect automatically', async () => {
    const payload = { request_id: 'req', error: { type: 'not_found_error', code: 'event_cursor_not_found', message: 'cursor missing', param: 'Last-Event-ID' } };
    const fetch = vi.fn(async () => jsonResponse(payload, 404, { 'Retry-After': 'Wed, 25 Nov 2026 10:00:00 GMT' }));
    vi.stubGlobal('fetch', fetch);
    await expect(streamEvents(apiContext, 'sess', vi.fn())).rejects.toMatchObject({
      status: 404, requestId: 'req', type: 'not_found_error', code: 'event_cursor_not_found', param: 'Last-Event-ID',
      raw: JSON.stringify(payload), retryAfter: 'Wed, 25 Nov 2026 10:00:00 GMT',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('reports a missing response body as failure rather than HTTP 200 success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'x-request-id': 'req' } })));
    await expect(streamEvents(apiContext, 'sess', vi.fn())).rejects.toMatchObject({ status: 502, requestId: 'req' });
  });

  test('cancels a blocked reader on abort and releases its lock', async () => {
    const stream = stubSse([], false);
    const controller = new AbortController();
    const onEvent = vi.fn();
    const onCursor = vi.fn();
    const pending = streamEvents(apiContext, 'sess', onEvent, controller.signal, undefined, { onCursor });
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await failure;
    expect(stream.fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onCursor).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  test('rejects an already-aborted stream and still releases an acquired reader', async () => {
    const stream = stubSse([], false);
    const controller = new AbortController();
    controller.abort();
    await expect(streamEvents(apiContext, 'sess', vi.fn(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  test('does not acknowledge an event if its callback aborts the stream', async () => {
    const stream = stubSse([sseBytes('id: cursor\ndata: {"id":"evt"}\n\n')], false);
    const controller = new AbortController();
    const onCursor = vi.fn();
    await expect(streamEvents(apiContext, 'sess', () => controller.abort(), controller.signal, undefined, { onCursor }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(onCursor).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  test('does not mask a callback exception with a cleanup failure', async () => {
    const stream = stubSse([sseBytes('data: {"id":"evt"}\n\n')], false);
    stream.cancel.mockRejectedValue(new Error('cleanup failed'));
    const failure = new Error('callback failed');
    await expect(streamEvents(apiContext, 'sess', () => { throw failure; })).rejects.toBe(failure);
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.body.locked).toBe(false);
  });

  test('releases the reader even when its read rejects', async () => {
    const stream = stubSse([], false);
    const reader = stream.body.getReader();
    const failure = new Error('connection lost');
    vi.spyOn(reader, 'read').mockRejectedValue(failure);
    await expect(streamEvents(apiContext, 'sess', vi.fn())).rejects.toBe(failure);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledTimes(1);
  });

  test('closes on DONE without processing later frames and removes abort listeners', async () => {
    const stream = stubSse([sseBytes('data: [DONE]\n\nid: later\ndata: {"id":"evt"}\n\n')], false);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const onEvent = vi.fn();
    await streamEvents(apiContext, 'sess', onEvent, controller.signal);
    controller.abort();
    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(stream.body.locked).toBe(false);
  });
});

function stubPages(pages: unknown[]) {
  const requests: Array<{ path: string; query: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const page = pages[requests.length - 1];
    if (page === undefined) throw new Error('Unexpected extra page request');
    return page instanceof Response ? page : jsonResponse(page);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}

describe('complete non-hot pagination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const lists = [
    ['templates', () => listTemplates(apiContext), '/templates', { status: 'active' }],
    ['resources', () => listResources(apiContext, 'skill'), '/resources', { type: 'skill' }],
    ['environments', () => listCloudEnvironments(apiContext), '/environments', {}],
    ['skills', () => listCloudSkills(apiContext), '/skills', {}],
    ['vaults', () => listCloudVaults(apiContext), '/vaults', {}],
    ['files', () => listCloudFiles(apiContext), '/files', {}],
    ['schedules', () => listSchedules(apiContext, 'identity'), '/schedules', { identity_id: 'identity', include_archived: false }],
    ['channels', () => listChannels(apiContext, 'identity'), '/channels', { identity_id: 'identity' }],
  ] as const;

  test.each(lists)('collects all %s beyond 50, including an empty page, using next_page then last_id', async (_name, list, path, filters) => {
    const first = Array.from({ length: 50 }, (_, index) => ({ id: `item_${index}` }));
    const final = [{ id: 'item_50' }, { id: 'item_51' }];
    const { requests, fetch } = stubPages([
      { data: first, first_id: 'item_0', last_id: 'item_49', next_page: 'opaque +/page', has_more: true },
      { data: [], last_id: 'empty-page-cursor', next_page: null, has_more: true },
      { data: final, first_id: 'item_50', last_id: 'item_51', next_page: null, has_more: false },
    ]);
    const result = await list();
    expect(result.data).toEqual([...first, ...final]);
    expect(result).toMatchObject({ first_id: 'item_0', last_id: 'item_51', next_page: null, has_more: false });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(requests).toEqual([
      expect.objectContaining({ path, query: { ...filters, limit: 50 } }),
      expect.objectContaining({ path, query: { ...filters, limit: 50, page: 'opaque +/page' } }),
      expect.objectContaining({ path, query: { ...filters, limit: 50, after_id: 'empty-page-cursor' } }),
    ]);
  });

  test.each(['skill', 'file', 'environment', 'vault'] as const)('fully traverses the %s catalog before filtering invalid resources', async type => {
    const { fetch } = stubPages([
      { data: [{ name: 'no id' }, null], last_id: 'raw-cursor', has_more: true },
      { data: [{ id: 'valid', display_title: 'Resource', filename: 'file.txt' }], has_more: false },
    ]);
    const result = await listResourceCatalog(apiContext, type);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.has_more).toBe(false);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: 'valid', type });
  });

  test('fully traverses the memory-store catalog via registry resources', async () => {
    const { requests } = stubPages([
      { data: [{ id: 'one' }], next_page: 'next', has_more: true },
      { data: [{ id: 'two' }], has_more: false },
    ]);
    expect((await listResourceCatalog(apiContext, 'memory_store')).data).toEqual([{ id: 'one' }, { id: 'two' }]);
    expect(requests[1]).toMatchObject({ path: '/resources', query: { type: 'memory_store', page: 'next' } });
  });

  test('does not claim exhaustion when next_page still exists', async () => {
    const { fetch } = stubPages([
      { data: [{ id: 'one' }], next_page: 'next', has_more: false },
      { data: [{ id: 'two' }], next_page: null, has_more: false },
    ]);
    expect((await listTemplates(apiContext)).data.map(item => item.id)).toEqual(['one', 'two']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ data: [], has_more: true }],
    [{ data: [{ id: 'not-a-cursor' }], has_more: true }],
    [{ data: [], next_page: '', last_id: '', has_more: true }],
    [{ data: [], next_page: 'repeat', has_more: true }, { data: [], next_page: 'repeat', has_more: true }],
    [{ data: [], last_id: 'repeat', has_more: true }, { data: [], last_id: 'repeat', has_more: true }],
    [{ data: [], next_page: 'repeat', has_more: true }, { data: [], last_id: 'repeat', has_more: true }],
    [{ data: [], next_page: 'a', has_more: true }, { data: [], next_page: 'b', has_more: true }, { data: [], next_page: 'a', has_more: true }],
  ])('rejects missing/repeated/cyclic cursors rather than silently truncating: %j', async (...pages) => {
    const { fetch } = stubPages(pages);
    await expect(listTemplates(apiContext)).rejects.toMatchObject({ status: 502, code: 'invalid_pagination_cursor' });
    expect(fetch).toHaveBeenCalledTimes(pages.length);
  });

  test.each([{ data: [] }, { has_more: false }, null])('does not invent exhaustion for an invalid page envelope: %j', async page => {
    const { fetch } = stubPages([page]);
    await expect(listCloudFiles(apiContext)).rejects.toMatchObject({ status: 502, code: 'invalid_pagination_response' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('propagates a later-page HTTP error instead of returning a partial list or retrying', async () => {
    const { fetch } = stubPages([
      { data: [{ id: 'one' }], last_id: 'one', has_more: true },
      jsonResponse({ error: { type: 'api_error', code: 'offline', message: 'offline' } }, 503),
    ]);
    await expect(listChannels(apiContext)).rejects.toMatchObject({ status: 503, code: 'offline' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('session hot-path page contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('stays on one page and preserves the original cursor before identity filtering', async () => {
    const { fetch, requests } = stubPages([
      { data: [{ id: 'raw', identity_id: 'other' }], first_id: 'raw', last_id: 'raw', next_page: 'opaque', has_more: true },
    ]);
    const page = await listSessions(apiContext, 'identity', 'template');
    expect(page).toEqual({ data: [], first_id: 'raw', last_id: 'raw', next_page: 'opaque', has_more: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests[0].query).toEqual({ identity_id: 'identity', template_id: 'template', order: 'desc', include_archived: false, limit: 50 });
  });

  test('captures raw last id even when the API omits last_id and filtering empties the page', async () => {
    stubPages([{ data: [{ id: 'raw', identity_id: 'other' }], has_more: true }]);
    expect(await listSessions(apiContext, 'identity')).toMatchObject({ data: [], last_id: 'raw', has_more: true });
  });

  test('lets the caller explicitly load more across empty filtered pages, without automatic traversal', async () => {
    const { fetch, requests } = stubPages([
      { data: [{ id: 'wrong', identity_id: 'other' }], next_page: 'page-2', has_more: true },
      { data: [], last_id: 'after-empty', has_more: true },
      { data: [{ id: 'mine', identity_id: 'identity' }], has_more: false },
    ]);
    const first = await listSessions(apiContext, 'identity');
    expect(fetch).toHaveBeenCalledTimes(1);
    const second = await listSessions(apiContext, 'identity', undefined, { page: first.next_page! });
    expect(fetch).toHaveBeenCalledTimes(2);
    const third = await listSessions(apiContext, 'identity', undefined, { afterId: second.last_id! });
    expect(third.data).toEqual([{ id: 'mine', identity_id: 'identity' }]);
    expect(requests[1].query).toMatchObject({ page: 'page-2' });
    expect(requests[1].query).not.toHaveProperty('after_id');
    expect(requests[2].query).toMatchObject({ after_id: 'after-empty' });
    expect(requests[2].query).not.toHaveProperty('page');
  });

  test('rejects mutually exclusive cursors before issuing a request', async () => {
    const { fetch } = stubPages([]);
    await expect(listSessions(apiContext, 'identity', undefined, { page: 'page', afterId: 'id' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    [{ data: [], has_more: true }, {}],
    [{ data: [], last_id: 'repeat', has_more: true }, { afterId: 'repeat' }],
    [{ data: [], next_page: 'repeat', has_more: true }, { page: 'repeat' }],
  ] as const)('rejects missing or non-advancing session cursors: %j', async (page, options) => {
    const { fetch } = stubPages([page]);
    await expect(listSessions(apiContext, 'identity', undefined, options)).rejects.toMatchObject({ status: 502, code: 'invalid_pagination_cursor' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('supports aborting a session-list poll via its fourth options argument', async () => {
    const controller = new AbortController();
    const { fetch } = stubPages([{ data: [], has_more: false }]);
    await listSessions(apiContext, 'identity', undefined, { signal: controller.signal });
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty('signal');
  });

  test.each([
    [() => listSessionsPage(apiContext, { afterId: 'cursor', limit: 12 }), '/sessions', { after_id: 'cursor', limit: 12 }],
    [() => listBatches(apiContext, { afterId: 'cursor', limit: 12 }), '/batches', { after_id: 'cursor', limit: 12 }],
    [() => listBatchTasks(apiContext, 'batch', { afterId: 'cursor', limit: 12 }), '/batches/batch/tasks', { after_id: 'cursor', limit: 12 }],
  ] as const)('does not widen existing Usage/Batch caller-managed pagination: %s', async (list, path, query) => {
    const { fetch, requests } = stubPages([{ data: [], last_id: 'next', has_more: true }]);
    expect((await list()).has_more).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({ path, query });
  });
});

describe('canonical template vaults', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('creates with canonical vaults only', async () => {
    const { requests } = stubPages([{ id: 'template' }]);
    const vaults = { vault_one: { enabled: true }, vault_two: { enabled: false } };
    await createTemplate(apiContext, { environment_id: ' env ', name: 'Agent', vaults });
    const request = requests[0] as unknown as { path: string; body: Record<string, unknown> };
    expect(request.path).toBe('/templates');
    expect(request.body).toMatchObject({ vaults, environment_id: 'env' });
    expect(request.body).not.toHaveProperty('vault_ids');
  });

  test('updates or clears vaults with merge-patch semantics and does not invent omitted fields', async () => {
    const { requests } = stubPages([{ id: 'template' }, { id: 'template' }, { id: 'template' }]);
    await updateTemplate(apiContext, 'a b', { vaults: { vault_one: { enabled: true } } });
    await updateTemplate(apiContext, 'a b', { vaults: {} });
    await updateTemplate(apiContext, 'a b', { name: 'Renamed' });
    expect(requests).toMatchObject([
      { path: '/templates/a%20b', body: { vaults: { vault_one: { enabled: true } } } },
      { path: '/templates/a%20b', body: { vaults: {} } },
      { path: '/templates/a%20b', body: { name: 'Renamed' } },
    ]);
    const bodies = requests.map(request => (request as unknown as { body: Record<string, unknown> }).body);
    expect(bodies[2]).not.toHaveProperty('vaults');
    for (const body of bodies) expect(body).not.toHaveProperty('vault_ids');
  });

  test('does not add an unverified fallback for legacy vault_ids inputs', async () => {
    const { requests } = stubPages([{ id: 'template' }, { id: 'template' }]);
    // Simulate a stale JavaScript caller; typed callers must migrate to vaults.
    const legacyInput = { environment_id: 'env', vault_ids: { legacy: { enabled: true } } };
    await createTemplate(apiContext, legacyInput);
    await updateTemplate(apiContext, 'template', legacyInput);
    const bodies = requests.map(request => (request as unknown as { body: Record<string, unknown> }).body);
    expect(bodies[0].vaults).toEqual({});
    expect(bodies[1]).not.toHaveProperty('vaults');
    for (const body of bodies) expect(body).not.toHaveProperty('vault_ids');
  });
});
