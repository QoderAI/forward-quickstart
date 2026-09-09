import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

// Exercise the actual Vercel entry export, with a local Forward replacement.
test('Vercel entry registers a server for runtime discovery and serves websocket upgrades', { timeout: 5000 }, async t => {
  const upstreamServer = createServer();
  const upstream = new WebSocketServer({ server: upstreamServer });
  upstream.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer deployment-test');
    assert.equal(request.url, '/api/v1/forward/realtime?conversation_id=conv_deployment');
    socket.send('ready');
  });
  upstreamServer.listen(0, '127.0.0.1'); await once(upstreamServer, 'listening');
  const original = { ...process.env };
  process.env.VERCEL = '1';
  process.env.VERCEL_URL = 'deployment-test.vercel.app';
  process.env.CN_PROD_FORWARD_API_BASE_URL = `http://127.0.0.1:${(upstreamServer.address() as import('node:net').AddressInfo).port}/api/v1/forward`;
  // Vercel's Node runner intercepts listen() while loading the entry module.
  let discoveredServer: Server | undefined;
  const listenMock = t.mock.method(Server.prototype, 'listen', function (this: Server) {
    discoveredServer = this;
    return this;
  });
  const { default: server } = await import('../api/voice/socket.js');
  listenMock.mock.restore();
  assert.equal(server.listening, false);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  let socket: WebSocket | undefined;
  t.after(async () => {
    process.env = original;
    socket?.terminate();
    for (const peer of upstream.clients) peer.terminate();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstreamServer.close(() => r()))]);
    upstream.close();
  });
  assert.equal(discoveredServer, server);
  assert.equal((await fetch(`http://${base}/api/voice/socket`)).status, 426);
  socket = new WebSocket(`ws://${base}/api/voice/socket`, { headers: { Origin: 'https://deployment-test.vercel.app' } });
  await once(socket, 'open');
  const message = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'proxy.auth', pat: 'deployment-test', environment: 'cn-prod', conversation_id: 'conv_deployment' }));
  assert.equal((await message)[0].toString(), 'ready');
});
