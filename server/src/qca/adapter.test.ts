import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { ForwardClient, ManagedClient } from 'qca-sdk';
import { clientOptions } from './clients.js';
import { dispatch } from './dispatch.js';
import { sdkResponse, sendResponse, sendError, requestScope } from './http.js';
import { uploadFile, previewFile } from './transfers.js';
import { relaySse } from './stream.js';

function fixture(handler: (request: Request) => Response | Promise<Response> = () => Response.json({ data: [], has_more: false })) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init); requests.push(request); return handler(request);
  };
  const forward = new ForwardClient({ ...clientOptions('https://cn.example/api/v1/forward', 'sat_test', 'service-account'), fetch });
  const cloud = new ManagedClient({ ...clientOptions('https://global.example/api/v1/cloud', 'pat_test', 'pat'), fetch });
  const call = (method: string, path: string, body?: unknown, query?: unknown, extra = {}) => dispatch(forward, { method, path, body, query, token: 'key_test', ...extra });
  return { requests, forward, cloud, call, fetch };
}

test('template writes preserve PATCH fields, beta header, idempotency and HTTP status', async () => {
  const f = fixture(() => Response.json({ id: 'tpl_1', future: true }, { status: 201, headers: { 'x-request-id': 'req_1' } }));
  const body = { name: 'template', model: { id: 'model_1' }, tools: [{ type: 'browser_toolset_20260714' }], system: null, files: {}, multiagent: false };
  const response = await f.call('POST', '/templates/tpl%20one', body, undefined, { idempotencyKey: 'stable' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-request-id'), 'req_1');
  assert.deepEqual(await response.json(), { id: 'tpl_1', future: true });
  const request = f.requests[0];
  assert.equal(request.url, 'https://cn.example/api/v1/forward/templates/tpl%20one');
  assert.deepEqual(await request.json(), body);
  assert.equal(request.headers.get('x-qoder-beta'), 'browser-use-2026-07-14');
  assert.equal(request.headers.get('Idempotency-Key'), 'stable');
  assert.equal(request.headers.get('Authorization'), 'Bearer sat_test');
  assert.equal(request.headers.get('X-Qoder-Package-Version'), '0.5.0');
});

test('concurrent users and regions do not share credentials; list queries retain false, zero and arrays', async () => {
  const f = fixture();
  const other = new ForwardClient({ ...clientOptions('https://global.example/api/v1/forward', 'other_pat', 'pat'), fetch: f.fetch });
  await Promise.all([
    f.call('GET', '/sessions', undefined, { identity_ids: ['i1', 'i2'], include_archived: false, limit: 0, absent: null, blank: '' }),
    dispatch(other, { method: 'GET', path: '/models', token: 'other_pat' }),
  ]);
  const cn = f.requests.find(r => new URL(r.url).hostname === 'cn.example')!;
  assert.equal(cn.headers.get('Authorization'), 'Bearer sat_test');
  const query = new URL(cn.url).searchParams;
  assert.deepEqual(query.getAll('identity_ids'), ['i1', 'i2']);
  assert.equal(query.get('include_archived'), 'false'); assert.equal(query.get('limit'), '0');
  assert.equal(query.has('absent'), false); assert.equal(query.has('blank'), false);
  assert.equal(f.requests.find(r => r !== cn)!.headers.get('Authorization'), 'Bearer other_pat');
});

test('SA login uses only the per-call Key and keeps issuance metadata, without retries', async () => {
  const token = { token: 'issued', expires_at: '2026-10-14T00:00:00Z', auth_token_id: 'auth_1', credential_id: 'cred_1', subject_type: 'admin' };
  const f = fixture(() => Response.json(token));
  const response = await f.call('POST', '/service_account_tokens', { ttl_seconds: 3600, metadata: { source: 'quickstart' } });
  assert.deepEqual(await response.json(), token);
  assert.equal(f.requests[0].headers.get('Authorization'), 'Bearer key_test');
  assert.deepEqual(await f.requests[0].json(), { ttl_seconds: 3600, metadata: { source: 'quickstart' } });
  await f.call('POST', '/identities/identity%20one/service_account_tokens', {});
  assert.match(f.requests[1].url, /identity%20one\/service_account_tokens$/);
  await f.call('GET', '/models');
  assert.equal(f.requests[2].headers.get('Authorization'), 'Bearer sat_test');
  const failure = fixture(() => Response.json({ error: { code: 'bad_key' } }, { status: 500 }));
  assert.equal((await failure.call('POST', '/service_account_tokens', {})).status, 500);
  assert.equal(failure.requests.length, 1);
});

test('error responses, request IDs, non-JSON bodies and delete response bodies survive the adapter', async () => {
  for (const status of [401, 403, 404, 409, 429, 502]) {
    const f = fixture(() => new Response('gateway detail', { status, headers: { 'x-trace-id': 'trace_test', 'content-type': 'text/plain' } }));
    const response = await f.call('GET', '/templates/tpl_1');
    assert.equal(response.status, status); assert.equal(await response.text(), 'gateway detail');
    assert.equal(response.headers.get('x-trace-id'), 'trace_test'); assert.equal(f.requests.length, 1);
  }
  const f = fixture(() => Response.json({ id: 'f1', deleted: true }));
  assert.deepEqual(await (await f.call('DELETE', '/files/f1')).json(), { id: 'f1', deleted: true });
  const empty = fixture(() => new Response(null, { status: 204 }));
  assert.equal((await empty.call('DELETE', '/files/f1')).status, 204);
});

test('Realtime REST maps idempotency headers and preserves the independent history wire DTO', async () => {
  const history = { conversation: { id: 'conv_1', config: { audio: { output: { voice: 'longanqian' } } } }, events: [], page: { has_more: true, next_before: 'cursor_old' }, future_field: true };
  const f = fixture(() => Response.json(history));
  const input = { identity_id: 'i1', template_id: 't1', config: history.conversation.config };
  await f.call('POST', '/realtime/conversations', input, undefined, { idempotencyKey: 'voice_key' });
  assert.deepEqual(await f.requests[0].json(), input);
  assert.equal(f.requests[0].headers.get('Idempotency-Key'), 'voice_key');
  assert.deepEqual(await (await f.call('GET', '/realtime/conversations/conv_1/history', undefined, { limit: 100, before: 'previous', types: 'message,work' })).json(), history);
  assert.equal(f.requests.length, 2); // proxy returns one page; browser owns pagination
  assert.equal(new URL(f.requests[1].url).searchParams.get('before'), 'previous');
});

test('schedule creation and updates preserve the initial user message through the real SDK', async () => {
  const f = fixture(() => Response.json({ id: 'sched_1' }));
  const initial_events = [{ type: 'user.message', content: '请只回复 SDK_SCHEDULE_OK_42。' }];
  const body = { identity_id: 'i1', template_id: 't1', name: 'sdk-smoke', trigger: { type: 'manual' }, initial_events };
  await f.call('POST', '/schedules', body);
  await f.call('POST', '/schedules/sched_1', { initial_events });
  assert.deepEqual(await f.requests[0].json(), body);
  assert.deepEqual(await f.requests[1].json(), { initial_events });
});

test('resource catalog and signed URL extensions stay explicit; Managed fallback uses its named resources', async () => {
  const f = fixture(() => Response.json({ url: 'https://storage.example/file' }));
  await f.call('GET', '/resources', undefined, { type: 'memory_store', limit: 50 });
  await f.call('GET', '/files/a%20b/content');
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].url, /files\/a%20b\/content$/);
  for (const path of ['/files/f1', '/files/f1/content', '/sessions/s1/resources']) {
    await dispatch(f.cloud, { method: 'GET', path, token: 'pat_test' });
    assert.match(f.requests.at(-1)!.url, /api\/v1\/cloud\//);
    assert.equal(f.requests.at(-1)!.headers.get('Authorization'), 'Bearer pat_test');
  }
  const count = f.requests.length;
  await assert.rejects(() => f.call('POST', '/unmapped', {}), /Unsupported/);
  await assert.rejects(() => f.call('GET', '/%2e%2e/files'), /invalid API path/);
  assert.equal(f.requests.length, count);
});

const file = { buffer: Buffer.from('zip'), originalname: 'skill.zip', mimetype: 'application/zip' } as Express.Multer.File;
test('multipart preserves filename, MIME, purpose and object metadata and uses files for skills', async () => {
  const f = fixture(() => Response.json({ id: 'uploaded' }, { status: 201 }));
  await uploadFile(f.forward, '/files', file, { purpose: 'session_resource', metadata: '{"source":"chat"}' }, {});
  const form = await f.requests[0].formData();
  assert.equal((form.get('file') as File).name, 'skill.zip');
  assert.equal((form.get('file') as File).type, 'application/zip');
  assert.equal(form.get('purpose'), 'session_resource');
  assert.deepEqual(JSON.parse(String(form.get('metadata'))), { source: 'chat' });
  await uploadFile(f.forward, '/skills', file, {}, { idempotencyKey: 'skill_key' });
  const skills = await f.requests[1].formData();
  assert.equal(skills.has('file'), false); assert.equal((skills.get('files') as File).name, 'skill.zip');
  assert.equal(f.requests[1].headers.get('Idempotency-Key'), 'skill_key');
  await assert.rejects(() => uploadFile(f.forward, '/files', file, { metadata: 'invalid' }, {}), /metadata/);
});

test('preview downloads bytes without leaking API authorization to storage in both layers', async () => {
  const f = fixture(request => {
    if (new URL(request.url).hostname === 'storage.example') return new Response('image bytes', { headers: { 'content-type': 'application/octet-stream' } });
    if (new URL(request.url).pathname.endsWith('/content')) return Response.json({ url: 'https://storage.example/file' });
    return Response.json({ mime_type: 'image/png' });
  });
  for (const client of [f.forward, f.cloud]) {
    const { content, mimeType } = await previewFile(client, 'f1', {});
    assert.equal(mimeType, 'image/png'); assert.equal(await content.text(), 'image bytes');
    assert.equal(f.requests.at(-1)!.headers.has('Authorization'), false);
    assert.equal(f.requests.at(-1)!.headers.has('X-Qoder-Package-Version'), false);
  }
});

test('artifact content remains downloadable when Forward metadata returns 404', async () => {
  const f = fixture(request => {
    if (new URL(request.url).hostname === 'storage.example') return new Response('png bytes', { headers: { 'content-type': 'image/png' } });
    if (new URL(request.url).pathname.endsWith('/content')) return Response.json({ url: 'https://storage.example/artifact' });
    return Response.json({ error: { code: 'file_not_found' } }, { status: 404 });
  });
  const { content, mimeType } = await previewFile(f.forward, 'artifact_1', {});
  assert.equal(mimeType, 'image/png');
  assert.equal(await content.text(), 'png bytes');
  assert.equal(f.requests.at(-1)!.headers.has('Authorization'), false);
});

test('SSE retains same-ID deltas and child-thread completion, carries cursor and cancels upstream', { timeout: 5000 }, async t => {
  let cancelled = false;
  let request: Request | undefined;
  const frames = [
    'id: e1\ndata: {"type":"agent.content_block_delta","delta":{"text":"你"}}\n\n',
    'data: {"type":"session.thread_status_idle"}\n\n',
    'id: e1\ndata: {"type":"agent.content_block_delta","delta":{"text":"好"}}\n\n',
    'data: {"type":"session.status_idle"}\n\n',
  ];
  const client = new ForwardClient({ ...clientOptions('https://cn.example', 'sat', 'service-account'), fetch: async (url, init) => {
    request = new Request(url, init);
    return new Response(new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode(frames.join(''));
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const app = express();
  app.get('/stream', async (req, res) => {
    const scope = requestScope(req, res, 0);
    try {
      const response = await sdkResponse(client.sessions.events.streamEvents('s1', { last_event_id: 'cursor_1' }, { signal: scope.signal }));
      res.type('text/event-stream'); await relaySse(response.body!, res, scope.signal); res.end();
    } finally { scope.dispose(); }
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const response = await fetch(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/stream`);
  assert.equal(await response.text(), frames.join(''));
  assert.equal(request!.headers.get('Last-Event-ID'), 'cursor_1'); assert.equal(cancelled, true);
});

test('Express boundary keeps status and request ID; a whole-request deadline maps to 504', { timeout: 5000 }, async t => {
  const app = express();
  app.get('/error', async (_req, res) => {
    const f = fixture(() => Response.json({ error: { code: 'quota' } }, { status: 429, headers: { 'x-trace-id': 'req_429', 'retry-after': '10' } }));
    await sendResponse(res, await f.call('GET', '/models'));
  });
  app.get('/timeout', async (req, res) => {
    const scope = requestScope(req, res, 10);
    const client = new ForwardClient({ ...clientOptions('https://offline.example', 'pat', 'pat'), fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
    try { await client.models.list({ signal: scope.signal }); }
    catch (error) { await sendError(res, error, scope.timedOut); }
    finally { scope.dispose(); }
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const error = await fetch(`${base}/error`); assert.equal(error.status, 429); assert.equal(error.headers.get('x-request-id'), 'req_429'); assert.equal(error.headers.get('retry-after'), '10');
  assert.deepEqual(await error.json(), { error: { code: 'quota' } });
  assert.equal((await fetch(`${base}/timeout`)).status, 504);
});
