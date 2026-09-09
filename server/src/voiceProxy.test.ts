import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { buildRealtimeUrl, createVoiceProxy, isAllowedLocalOrigin, relayCloseCode } from './voiceProxy.js';
import { voiceConfig } from './voiceConfig.js';

const auth = { type: 'proxy.auth', pat: 'test-secret', environment: 'cn-prod', conversation_id: 'conv_test' };
const event = JSON.stringify({ type: 'voice.ready', payload: {} });
async function fixture(t: import('node:test').TestContext, overrides: Partial<Parameters<typeof createVoiceProxy>[0]> = {}, rejection?: number) {
  const upstreamServer = createServer();
  const upstream = new WebSocketServer({ noServer: true });
  const received: string[] = [];
  const requests: { url?: string; authorization?: string }[] = [];
  upstreamServer.on('upgrade', (req, socket, head) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (rejection) { socket.end(`HTTP/1.1 ${rejection} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    upstream.handleUpgrade(req, socket, head, ws => {
      ws.send(event);
      ws.on('message', data => { received.push(data.toString()); ws.send(data); });
    });
  });
  upstreamServer.listen(0, '127.0.0.1'); await once(upstreamServer, 'listening');
  const port = (upstreamServer.address() as import('node:net').AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api/v1/forward`;
  const server = createServer();
  createVoiceProxy({ baseUrls: { 'cn-prod': base, 'global-prod': base }, ...overrides }).attach(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    for (const ws of upstream.clients) ws.terminate();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstreamServer.close(() => r()))]);
    upstream.close();
  });
  const connect = (origin = 'http://localhost:5173', query = '') => {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/voice/socket${query}`, { headers: { Origin: origin } });
    sockets.push(ws); return ws;
  };
  return { connect, requests, received, upstream };
}

test('URLs and origin policy', () => {
  assert.equal(buildRealtimeUrl('https://example.com/api/v1/forward/', 'a b').href, 'wss://example.com/api/v1/forward/realtime?conversation_id=a+b');
  assert.equal(isAllowedLocalOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedLocalOrigin('https://localhost.evil.com'), false);
  assert.equal(isAllowedLocalOrigin('file://localhost'), false);
  assert.equal(relayCloseCode(1006, 1011), 1011);
});
test('Vercel config uses exact deployment origins and rotates before maxDuration', () => {
  const config = voiceConfig({ VERCEL: '1', VERCEL_URL: 'preview.vercel.app', VERCEL_BRANCH_URL: 'branch.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'demo.vercel.app', VOICE_ALLOWED_ORIGINS: 'https://demo.example.com' });
  assert.equal(config.allowLocal, false);
  assert.equal(config.maxConnectionMs, 280000);
  assert.deepEqual(config.allowedOrigins, ['https://preview.vercel.app', 'https://branch.vercel.app', 'https://demo.vercel.app', 'https://demo.example.com']);
  assert.throws(() => voiceConfig({ VOICE_ALLOWED_ORIGINS: 'https://example.com/path' }));
  assert.equal(createVoiceProxy(voiceConfig({ VERCEL: '1' })).enabled, false);
});
test('authenticates within each socket, forwards both directions and releases upstream', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const ws = f.connect(); await once(ws, 'open');
    const ready = once(ws, 'message'); ws.send(JSON.stringify(auth));
    assert.equal((await ready)[0].toString(), event);
    const echo = once(ws, 'message'); ws.send('audio-data');
    assert.equal((await echo)[0].toString(), 'audio-data');
    const upstream = [...f.upstream.clients][0];
    const closed = once(upstream, 'close'); ws.close(); await closed;
  }
  assert.deepEqual(f.received, ['audio-data', 'audio-data']);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].authorization, 'Bearer test-secret');
  assert.equal(f.requests[0].url, '/api/v1/forward/realtime?conversation_id=conv_test');
});
test('rejects foreign origins, local origin on Vercel and credentials in URL', { timeout: 5000 }, async t => {
  const f = await fixture(t, { allowLocal: false, allowedOrigins: ['https://demo.vercel.app'] });
  for (const [origin, query, status] of [['https://evil.vercel.app', '', 403], ['http://localhost:5173', '', 403], ['https://demo.vercel.app', '?key=secret', 400]] as const) {
    const ws = f.connect(origin, query);
    const response = await once(ws, 'unexpected-response');
    assert.equal(response[1].statusCode, status); response[1].resume();
    ws.on('error', () => {}); ws.terminate();
  }
  const ws = f.connect('https://demo.vercel.app'); await once(ws, 'open');
  const ready = once(ws, 'message'); ws.send(JSON.stringify(auth)); await ready;
});
test('rejects malformed auth before opening upstream', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const value of ['bad-json', '{}', JSON.stringify({ ...auth, environment: 'arbitrary' }), JSON.stringify({ ...auth, pat: 'bad\r\nheader' })]) {
    const ws = f.connect(); await once(ws, 'open');
    const closed = once(ws, 'close'); ws.send(value);
    assert.equal((await closed)[0], 4400);
  }
  assert.equal(f.requests.length, 0);
});
test('unauthenticated clients expire', { timeout: 5000 }, async t => {
  const f = await fixture(t, { authTimeoutMs: 30 });
  const ws = f.connect(); assert.equal((await once(ws, 'close'))[0], 4408);
  assert.equal(f.requests.length, 0);
});
test('upstream authentication rejection is terminal', { timeout: 5000 }, async t => {
  const f = await fixture(t, {}, 401);
  const ws = f.connect(); await once(ws, 'open');
  const closed = once(ws, 'close'); ws.send(JSON.stringify(auth));
  assert.equal((await closed)[0], 4401);
});
test('duration rotation requests reconnect and closes upstream', { timeout: 5000 }, async t => {
  const f = await fixture(t, { maxConnectionMs: 100 });
  const ws = f.connect(); await once(ws, 'open');
  const closed = once(ws, 'close'); ws.send(JSON.stringify(auth));
  assert.equal((await closed)[0], 1012);
});
