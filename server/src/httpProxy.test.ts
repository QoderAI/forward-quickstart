import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the actual Express routes, including multipart and response cleanup.
// All QCA/storage destinations point at this local server; no real tokens are used.
test('HTTP proxy integrates the SDK across JSON, upload, preview and SSE routes', { timeout: 10000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'forward-http-'));
  const originalCwd = process.cwd();
  const envKeys = ['VERCEL', 'CN_PROD_FORWARD_API_BASE_URL', 'GLOBAL_PROD_FORWARD_API_BASE_URL', 'CN_PROD_CLOUD_API_BASE_URL', 'GLOBAL_PROD_CLOUD_API_BASE_URL'];
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  const requests: Array<{ path: string; auth?: string; method?: string }> = [];
  const streamRequests: Array<{ query: URLSearchParams; headers: import('node:http').IncomingHttpHeaders; httpVersion: string }> = [];
  const thinkingBeta = 'thinking-event-stream-delta-2026-07-20';
  const streamFrames = [
    'id: e1\nevent: event_start\ndata: {"type":"event_start","event":{"type":"agent.message"}}\n\n',
    'id: e1\nevent: event_delta\ndata: {"type":"event_delta","delta":{"content":{"type":"text","text":"你好"}}}\n\n',
    'data: {"type":"session.thread_status_idle"}\n\n',
    'id: e1\nevent: event_delta\ndata: {"type":"event_delta","delta":{"content":{"type":"thinking","text":"思考"}}}\n\n',
    'data: {"type":"session.status_idle","stop_reason":{"type":"requires_action"}}\n\n',
    'id: e1\nevent: agent.message\ndata: {"type":"agent.message","content":"完成"}\n\n',
    'data: {"type":"session.status_idle"}\n\n',
  ].join('');
  let releaseStream!: () => void;
  const streamReleased = new Promise<void>(resolve => { releaseStream = resolve; });
  let upstreamBase = '';
  const upstream = createServer(async (req, res) => {
    const path = req.url!;
    requests.push({ path, auth: req.headers.authorization, method: req.method });
    if (path === '/storage') {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['x-qoder-package-version'], undefined);
      res.end('image bytes'); return;
    }
    assert.equal(req.headers['x-qoder-package-version'], '0.5.0');
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization === 'Bearer bad_pat') {
      res.writeHead(403, { 'x-request-id': 'req_denied' });
      res.end(JSON.stringify({ error: { code: 'forbidden', message: 'denied' } })); return;
    }
    if (path.includes('/events/stream')) {
      streamRequests.push({ query: new URL(path, upstreamBase).searchParams, headers: { ...req.headers }, httpVersion: req.httpVersion });
      if (path.includes('/sessions/quota/')) {
        res.writeHead(429, { 'x-request-id': 'req_sse_quota', 'retry-after': '17' });
        res.end(JSON.stringify({ error: { code: 'quota', message: 'retry later' } })); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_stream' });
      if (path.includes('/sessions/s1/')) {
        assert.equal(req.headers['last-event-id'], 'resume_1');
        res.write('id: e1\ndata: {"type":"agent.message","content":"你好"}\n\n');
        res.once('close', releaseStream); return;
      }
      const bytes = Buffer.from(streamFrames);
      for (let i = 0; i < bytes.length && !res.destroyed; i += 7) {
        res.write(bytes.subarray(i, i + 7));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      res.end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (req.headers['content-type']?.startsWith('multipart/form-data')) {
      const form = await new Request(`${upstreamBase}${path}`, { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData();
      assert.equal(form.has('pat'), false); assert.equal(form.has('authMode'), false);
      res.writeHead(201);
      res.end(JSON.stringify({ filename: ((form.get('files') || form.get('file')) as File)?.name,
        metadata: form.get('metadata') ? JSON.parse(String(form.get('metadata'))) : null, purpose: form.get('purpose'), skills: form.has('files') })); return;
    }
    if (path.endsWith('/service_account_tokens')) {
      assert.equal(req.headers.authorization, 'Bearer login_key');
      const input = JSON.parse(body.toString()); assert.equal(input.saKey, undefined);
      res.end(JSON.stringify({ token: 'forward_sat', expires_at: '2026-10-14T00:00:00Z', subject_type: 'admin' })); return;
    }
    if (path.endsWith('/files/f1/content')) { res.end(JSON.stringify({ url: `${upstreamBase}/storage` })); return; }
    if (path.endsWith('/files/f1')) { res.end(JSON.stringify({ id: 'f1', mime_type: 'image/png' })); return; }
    if (req.method === 'POST') {
      res.writeHead(201, { 'x-request-id': 'req_created' });
      res.end(JSON.stringify({ id: 'created', body: JSON.parse(body.toString()) })); return;
    }
    res.end(JSON.stringify({ data: [], has_more: false }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  upstreamBase = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`;
  process.chdir(temp); // Do not load the user's .env or write to their logs.
  process.env.VERCEL = '1';
  for (const region of ['CN', 'GLOBAL']) for (const layer of ['FORWARD', 'CLOUD']) {
    process.env[`${region}_PROD_${layer}_API_BASE_URL`] = `${upstreamBase}/${region.toLowerCase()}/${layer.toLowerCase()}`;
  }
  const { default: app } = await import('./index.js');
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    process.chdir(originalCwd);
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(temp, { recursive: true, force: true });
  });
  const json = (layer: string, body: object, signal?: AbortSignal) => fetch(`${base}/api/${layer}/request`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pat: 'forward_sat', authMode: 'service-account', environment: 'cn-prod', ...body }) });

  await t.test('SA issuer, SAT writes, Global PAT and Managed fallback preserve contracts', async () => {
    const login = await json('forward', { path: '/service_account_tokens', method: 'POST', pat: 'login_key', body: { metadata: { source: 'test' } } });
    assert.equal((await login.json()).token, 'forward_sat');
    const response = await json('forward', { path: '/templates', method: 'POST', body: { name: 'test', tools: [] }, idempotencyKey: 'template_key' });
    assert.equal(response.status, 201); assert.equal(response.headers.get('x-request-id'), 'req_created');
    assert.deepEqual((await response.json()).body, { name: 'test', tools: [] });
    await json('forward', { method: 'GET', path: '/models', environment: 'global-prod', pat: 'global_pat', authMode: 'pat' });
    assert.deepEqual(requests.at(-1), { method: 'GET', path: '/global/forward/models', auth: 'Bearer global_pat' });
    await json('cloud', { method: 'GET', path: '/sessions/s1/resources', pat: 'legacy_pat', authMode: 'pat' });
    assert.match(requests.at(-1)!.path, /^\/cn\/cloud\/sessions\/s1\/resources/);
  });
  await t.test('upstream authorization errors keep status, code and request ID', async () => {
    const response = await json('forward', { path: '/models', pat: 'bad_pat', method: 'GET' });
    assert.equal(response.status, 403); assert.equal(response.headers.get('x-request-id'), 'req_denied');
    assert.equal((await response.json()).error.code, 'forbidden');
  });
  await t.test('multipart removes local auth fields and preserves upload semantics', async () => {
    for (const path of ['/files', '/skills']) {
      const form = new FormData();
      form.set('pat', 'forward_sat'); form.set('authMode', 'service-account'); form.set('environment', 'cn-prod'); form.set('path', path);
      form.set('file', new File(['bytes'], 'skill.zip', { type: 'application/zip' })); form.set('metadata', '{"source":"test"}'); form.set('purpose', 'session_resource');
      const response = await fetch(`${base}/api/forward/upload`, { method: 'POST', body: form, headers: { 'idempotency-key': 'upload_key' } });
      assert.equal(response.status, 201);
      const body = await response.json(); assert.equal(body.filename, 'skill.zip'); assert.deepEqual(body.metadata, { source: 'test' });
      assert.equal(body.skills, path === '/skills'); if (path === '/files') assert.equal(body.purpose, 'session_resource');
    }
  });
  await t.test('both preview routes fetch private storage without API headers', async () => {
    for (const layer of ['forward', 'cloud']) {
      const response = await fetch(`${base}/api/${layer}/files/f1/preview?environment=cn-prod&authMode=pat`, { headers: { Authorization: 'Bearer preview_pat' } });
      assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
      assert.equal(await response.text(), 'image bytes');
    }
  });
  await t.test('SSE query whitelist preserves repeated bracket deltas and booleans on the real wire', async () => {
    assert.equal(app.get('query parser'), 'simple');
    const cases: Array<{ query: Array<[string, string]>; beta?: string; thinking?: boolean }> = [
      { query: [], beta: thinkingBeta },
      { query: [['event_deltas[]', 'agent.message']] },
      { query: [['event_deltas[]', 'agent.message'], ['event_deltas[]', 'agent.message']], beta: thinkingBeta },
      { query: [['event_deltas[]', 'agent.thinking']], thinking: true },
      { query: [['event_deltas[]', 'agent.message'], ['event_deltas[]', 'agent.thinking']], beta: thinkingBeta, thinking: true },
      { query: [['event_deltas[]', 'agent.thinking'], ['event_deltas[]', 'agent.message']], beta: 'arbitrary-beta', thinking: true },
      { query: [['include_thinking', 'true'], ['include_tool_calls', 'false']], beta: 'arbitrary-beta' },
      { query: [['event_deltas[]', 'agent.message'], ['include_thinking', 'false'], ['include_tool_calls', 'true']] },
      { query: [['event_deltas[]', 'agent.thinking'], ['include_thinking', 'false'], ['include_tool_calls', 'false']], thinking: true },
      { query: [['type', 'agent.message'], ['types', 'agent.message'], ['types', 'session.status_idle']] },
      { query: [['type', 'agent.thinking'], ['types', 'agent.thinking'], ['event_deltas[]', 'agent.message']], beta: thinkingBeta },
    ];
    for (const scenario of cases) {
      const query = new URLSearchParams([
        ['environment', 'global-prod'], ['authMode', 'pat'], ['unknown', 'not-forwarded'],
        ['last_event_id', 'not-a-header'], ['X-Qoder-Beta', 'not-forwarded'], ...scenario.query,
      ]);
      const response = await fetch(`${base}/api/forward/sessions/wire/events/stream?${query}`, {
        headers: {
          Authorization: 'Bearer sse_pat', 'Last-Event-ID': 'wire_cursor', Accept: 'application/json',
          'X-Untrusted': 'not-forwarded', Cookie: 'secret=test', 'Idempotency-Key': 'not-forwarded',
          ...(scenario.beta ? { 'X-Qoder-Beta': scenario.beta } : {}),
        },
      });
      assert.equal(response.status, 200, query.toString());
      assert.equal(response.headers.get('x-request-id'), 'req_stream');
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.equal(await response.text(), streamFrames); // Same IDs, UTF-8 and frame boundaries split across chunks.
      const wire = streamRequests.at(-1)!;
      assert.equal(wire.httpVersion, '1.1');
      assert.deepEqual([...wire.query], scenario.query);
      assert.equal(wire.headers.authorization, 'Bearer sse_pat');
      assert.equal(wire.headers.accept, 'text/event-stream');
      assert.equal(wire.headers['last-event-id'], 'wire_cursor');
      assert.equal(wire.headers['x-qoder-beta'], scenario.thinking ? thinkingBeta : undefined);
      for (const header of ['x-untrusted', 'cookie', 'idempotency-key']) assert.equal(wire.headers[header], undefined);
      assert.match(requests.at(-1)!.path, /^\/global\/forward\/sessions\/wire\/events\/stream/);
    }
    const response = await fetch(`${base}/api/forward/sessions/wire/events/stream`, { headers: { Authorization: 'Bearer sse_pat' } });
    assert.equal(response.status, 200); assert.equal(await response.text(), streamFrames);
    assert.deepEqual([...streamRequests.at(-1)!.query], []);
    assert.equal(streamRequests.at(-1)!.headers['last-event-id'], undefined);
    assert.equal(streamRequests.at(-1)!.headers['x-qoder-beta'], undefined);
  });
  await t.test('SSE rejects invalid delta values, boolean values and malformed parameter shapes before upstream', async () => {
    const invalid = [
      'event_deltas[]=', 'event_deltas[]', 'event_deltas[]=agent.tool_call',
      'event_deltas[]=agent.message,agent.thinking', 'event_deltas[]=AGENT.MESSAGE',
      'event_deltas[]=agent.message&event_deltas[]=invalid', 'event_deltas[]=agent.message&event_deltas[]=',
      'event_deltas=agent.message', 'event_deltas[0]=agent.thinking', 'event_deltas[type]=agent.thinking',
      ...['include_thinking', 'include_tool_calls'].flatMap(key => [
        `${key}=`, key, `${key}=1`, `${key}=0`, `${key}=TRUE`, `${key}=null`, `${key}=yes`,
        `${key}=true&${key}=false`, `${key}=true&${key}=true`, `${key}[]=true`, `${key}[value]=false`,
      ]),
    ];
    const before = requests.length;
    for (const query of invalid) {
      const response = await fetch(`${base}/api/forward/sessions/wire/events/stream?${query}`, { headers: { Authorization: 'Bearer sse_pat' } });
      assert.equal(response.status, 400, query);
      assert.match((await response.json()).error.message, /event_deltas|include_thinking|include_tool_calls/, query);
    }
    assert.equal(requests.length, before);
  });
  await t.test('SSE upstream errors preserve status, body, request ID and Retry-After without retries', async () => {
    const before = streamRequests.length;
    const response = await fetch(`${base}/api/forward/sessions/quota/events/stream?event_deltas[]=agent.thinking`, { headers: { Authorization: 'Bearer sse_pat' } });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('x-request-id'), 'req_sse_quota');
    assert.equal(response.headers.get('retry-after'), '17');
    assert.deepEqual(await response.json(), { error: { code: 'quota', message: 'retry later' } });
    assert.equal(streamRequests.length, before + 1);
    assert.equal(streamRequests.at(-1)!.headers['x-qoder-beta'], thinkingBeta);
  });
  await t.test('an active SSE stream does not block session writes and disconnect releases upstream', async () => {
    const previousDispatcher = getGlobalDispatcher();
    const ordinaryDispatcher = new Agent({ connections: 1 });
    const browserDispatcher = new Agent();
    setGlobalDispatcher(ordinaryDispatcher);
    const controller = new AbortController();
    try {
      const response = await fetch(`${base}/api/forward/sessions/s1/events/stream?environment=cn-prod&authMode=service-account&event_deltas[]=agent.message&event_deltas[]=agent.thinking&include_thinking=true&include_tool_calls=false`, {
        headers: { Authorization: 'Bearer forward_sat', 'Last-Event-ID': 'resume_1', 'X-Qoder-Beta': thinkingBeta },
        signal: controller.signal, dispatcher: browserDispatcher,
      } as RequestInit & { dispatcher: Agent });
      assert.equal(response.status, 200);
      assert.equal(streamRequests.at(-1)!.httpVersion, '1.1');
      assert.deepEqual([...streamRequests.at(-1)!.query], [
        ['event_deltas[]', 'agent.message'], ['event_deltas[]', 'agent.thinking'],
        ['include_thinking', 'true'], ['include_tool_calls', 'false'],
      ]);
      assert.equal(streamRequests.at(-1)!.headers['x-qoder-beta'], thinkingBeta);
      const reader = response.body!.getReader();
      try {
        assert.match(new TextDecoder().decode((await reader.read()).value), /你好/);
        for (const sessionId of ['s1', 's2']) {
          const write = await json('forward', { path: `/sessions/${sessionId}/events`, method: 'POST', body: { type: 'user.message', content: 'hello' } }, AbortSignal.timeout(1500));
          assert.equal(write.status, 201);
          assert.deepEqual((await write.json()).body, { type: 'user.message', content: 'hello' });
          assert.equal(requests.at(-1)!.auth, 'Bearer forward_sat');
        }
        const globalWrite = await json('forward', { path: '/sessions/s3/events', method: 'POST', environment: 'global-prod', pat: 'global_pat', authMode: 'pat', body: { type: 'user.message', content: 'global' } }, AbortSignal.timeout(1500));
        assert.equal(globalWrite.status, 201); await globalWrite.json();
        assert.deepEqual(requests.at(-1), { path: '/global/forward/sessions/s3/events', auth: 'Bearer global_pat', method: 'POST' });
      } finally {
        controller.abort(); await reader.cancel().catch(() => undefined); await streamReleased;
      }
    } finally {
      controller.abort();
      setGlobalDispatcher(previousDispatcher);
      await Promise.all([ordinaryDispatcher.destroy(), browserDispatcher.destroy()]);
    }
  });
});
