import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
      assert.equal(req.headers['last-event-id'], 'resume_1');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: e1\ndata: {"type":"agent.message","content":"你好"}\n\n');
      res.once('close', releaseStream); return;
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
  const json = (layer: string, body: object) => fetch(`${base}/api/${layer}/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pat: 'forward_sat', authMode: 'service-account', environment: 'cn-prod', ...body }) });

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
  await t.test('disconnecting the browser cancels the active SDK SSE body', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/forward/sessions/s1/events/stream?environment=cn-prod&authMode=service-account`, { headers: { Authorization: 'Bearer forward_sat', 'Last-Event-ID': 'resume_1' }, signal: controller.signal });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /你好/);
    controller.abort(); await reader.cancel().catch(() => undefined); await streamReleased;
  });
});
