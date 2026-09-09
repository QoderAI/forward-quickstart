import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { VoiceConnection } from '../client/src/voice/voiceConnection.js';
import { createRealtimeConversation, getCompleteRealtimeConversationHistory, getVoiceProxyCapability, REALTIME_VOICES } from '../client/src/voice/voiceApi.js';

const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
};
const version = 'voice.realtime.v1';

test('local build and Vercel exports have the same realtime contract', { timeout: 30000 }, async t => {
  const originalFetch = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const temp = await mkdtemp(join(tmpdir(), 'voice-parity-'));
  const records: unknown[] = [];
  const peers = new Map<string, WebSocket>();
  const mock = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer parity-test');
    let body = ''; for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : undefined;
    records.push({ kind: 'http', method: req.method, url: req.url, input });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      assert.ok(req.headers['idempotency-key']);
      res.end(JSON.stringify({ id: 'conv_parity', type: 'voice.conversation', status: 'ready', config: input.config }));
    } else {
      res.end(JSON.stringify({ conversation: { id: 'conv_parity', initialization_status: 'ready' }, events: [], page: { has_more: false, next_before: null } }));
    }
  });
  const wss = new WebSocketServer({ server: mock });
  let connectionNumber = 0;
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, 'Bearer parity-test');
    const url = new URL(req.url!, 'http://upstream');
    assert.equal(url.searchParams.get('conversation_id'), 'conv_parity');
    assert.ok(!url.searchParams.has('pat'));
    peers.set(url.pathname, ws);
    let sequence = 0;
    const number = ++connectionNumber;
    const send = (type: string, payload: Record<string, unknown>) => ws.send(JSON.stringify({ version, type, payload, event_id: `evt_${number}_${++sequence}`, sequence, conversation_id: 'conv_parity', timestamp: new Date().toISOString() }));
    send('voice.ready', { capabilities: { graceful_close: true } });
    ws.on('message', data => {
      const event = JSON.parse(data.toString());
      records.push({ kind: 'ws', path: url.pathname, event });
      if (event.type === 'connection.close') send('connection.closed', { request_id: event.payload.request_id, outcome: 'saved_interrupted' });
      else if (event.type === 'audio.append') send('audio.delta', { delta: event.payload.audio });
      else if (event.type === 'text.message') send('transcript.final', { text: event.payload.text });
    });
  });
  const mockPort = await listen(mock);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousSocket) Object.defineProperty(globalThis, 'WebSocket', previousSocket); else Reflect.deleteProperty(globalThis, 'WebSocket');
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(r => mock.close(() => r())); wss.close();
    await rm(temp, { recursive: true, force: true });
  });
  const results: unknown[][] = [];
  for (const mode of ['local', 'vercel']) {
    await t.test(mode, async sub => {
      const reservation = createServer(); const port = await listen(reservation);
      await new Promise<void>(r => reservation.close(() => r()));
      const env = { ...process.env, TEST_DEPLOYMENT: mode, PORT: String(port), VERCEL: mode === 'vercel' ? '1' : '', VERCEL_URL: 'parity.vercel.app', CN_PROD_FORWARD_API_BASE_URL: `http://127.0.0.1:${mockPort}/cn`, GLOBAL_PROD_FORWARD_API_BASE_URL: `http://127.0.0.1:${mockPort}/global` };
      const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tests/fixtures/deploymentServer.ts')], { env, cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] });
      sub.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
      await new Promise<void>((resolveReady, reject) => {
        let stderr = '';
        child.on('error', reject); child.on('exit', code => reject(new Error(`server exited ${code}: ${stderr}`)));
        child.stdout.on('data', data => { if (/server running|deployment ready/.test(String(data))) resolveReady(); });
        child.stderr.on('data', data => { stderr += String(data); });
      });
      const base = `http://127.0.0.1:${port}`;
      globalThis.fetch = (input, init) => originalFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { location: { href: base }, setTimeout, clearTimeout, setInterval, clearInterval }) });
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: WebSocket });
      assert.equal(await getVoiceProxyCapability(), true);
      const origin = mode === 'local' ? base : 'https://parity.vercel.app';
      for (const input of [{}, { type: 'proxy.auth', pat: 'parity-test', environment: 'invalid', conversation_id: 'conv_parity' }]) {
        const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/voice/socket`, { headers: { Origin: origin } });
        await once(socket, 'open');
        const closed = once(socket, 'close'); socket.send(JSON.stringify(input));
        assert.equal((await closed)[0], 4400);
      }
      for (const [requestOrigin, suffix, status] of [['https://foreign.example', '', 403], [origin, '?pat=forbidden', 400]] as const) {
        const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/voice/socket${suffix}`, { headers: { Origin: requestOrigin } });
        socket.on('error', () => {});
        const [, response] = await once(socket, 'unexpected-response');
        assert.equal(response.statusCode, status); response.resume(); socket.terminate();
      }
      const start = records.length;
      for (const environment of ['cn-prod', 'global-prod'] as const) {
        const ctx = { pat: 'parity-test', environment };
        for (const voice of REALTIME_VOICES) {
          const conversation = await createRealtimeConversation(ctx, { templateId: 'tmpl_test', identityId: 'identity_test', voice: voice.id, idempotencyKey: `create-${voice.id}` });
          assert.equal(conversation.config.audio.output.voice, voice.id);
        }
        const events = new EventEmitter();
        let historyLoads = 0;
        const connection = new VoiceConnection({
          conversationId: 'conv_parity', getCredentials: async () => ctx,
          beforeReconnect: async () => { await getCompleteRealtimeConversationHistory(ctx, 'conv_parity'); historyLoads++; },
          onEvent: event => events.emit(event.type, event.payload),
          onError: error => events.emit('error', error),
          webSocketFactory: url => new WebSocket(url, { headers: { Origin: mode === 'local' ? base : 'https://parity.vercel.app' } }) as unknown as globalThis.WebSocket,
        });
        sub.after(() => connection.disconnect());
        let ready = once(events, 'voice.ready'); await connection.connect(); await ready;
        const audio = once(events, 'audio.delta'); assert.equal(connection.send('audio.append', { audio: 'AAAA' }), true);
        assert.equal((await audio)[0].delta, 'AAAA');
        const text = once(events, 'transcript.final'); connection.send('text.message', { text: 'deployment parity' });
        assert.equal((await text)[0].text, 'deployment parity');
        // Simulate the same restart code used for the Vercel duration boundary.
        ready = once(events, 'voice.ready'); peers.get(environment === 'cn-prod' ? '/cn/realtime' : '/global/realtime')!.close(1012, 'restart');
        await ready; assert.equal(historyLoads, 1);
        assert.deepEqual(await connection.closeGracefully(), { outcome: 'saved_interrupted' });
        connection.disconnect();
      }
      results.push(records.slice(start).map(record => {
        const normalized = structuredClone(record) as { event?: { type: string; payload: Record<string, unknown> } };
        if (normalized.event?.type === 'connection.close') normalized.event.payload.request_id = 'normalized-id';
        return normalized;
      }));
    });
  }
  assert.deepEqual(results[0], results[1]);
});
