import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';

// Set environment variables on the real process.env object and restore them
// key by key; wholesale process.env assignment would detach later tests'
// writes from the actual environment.
function setEnv(vars: Record<string, string>) {
  const originals = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    originals.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// Vercel compiles API entries to CommonJS while the server package stays ESM
// ("type": "module"), so require() of a statically imported server module
// crashes the function at runtime with ERR_REQUIRE_ESM (issue #17). The voice
// entry must therefore only statically import node builtins and load the
// server modules with dynamic import(), like the other API entries.
test('voice entry only statically imports node builtins', async () => {
  const source = await readFile(new URL('../api/voice/socket.ts', import.meta.url), 'utf8');
  const specifiers = source.split('\n').flatMap(line => {
    if (!/^import\s/.test(line) || /^import\s+type\s/.test(line)) return [];
    return [line.match(/from\s+['"]([^'"]+)['"]/)?.[1] ?? line];
  });
  assert.deepEqual(
    specifiers.filter(specifier => !specifier.startsWith('node:')),
    [],
    'api/voice/socket.ts must load server modules with dynamic import()',
  );
});

// The proxy attaches through a dynamic import, so an upgrade can reach the
// entry before the proxy is ready (for example a cold start). The scenario
// runs in a subprocess so the entry module is evaluated fresh.
test('upgrades arriving before the proxy attaches are queued and completed', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tests/fixtures/coldStartSocket.ts')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const [code] = await once(child, 'exit') as unknown as [number | null];
  assert.equal(code, 0, `cold-start fixture failed\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(stdout, /coldstart ok/);
});

// Exercise the actual Vercel entry export, with a local Forward replacement.
test('Vercel entry exports a non-listening server and relays websocket upgrades', { timeout: 5000 }, async t => {
  const upstreamServer = createServer();
  const upstream = new WebSocketServer({ server: upstreamServer });
  upstream.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer deployment-test');
    assert.equal(request.url, '/api/v1/forward/realtime?conversation_id=conv_deployment');
    socket.send('ready');
  });
  upstreamServer.listen(0, '127.0.0.1'); await once(upstreamServer, 'listening');
  const restoreEnv = setEnv({
    VERCEL: '1',
    VERCEL_URL: 'deployment-test.vercel.app',
    CN_PROD_FORWARD_API_BASE_URL: `http://127.0.0.1:${(upstreamServer.address() as import('node:net').AddressInfo).port}/api/v1/forward`,
  });
  const { default: server } = await import('../api/voice/socket.js');
  // Vercel wires the exported server itself; the entry never listens on its own.
  assert.equal(server.listening, false);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  let socket: WebSocket | undefined;
  t.after(async () => {
    restoreEnv();
    socket?.terminate();
    for (const peer of upstream.clients) peer.terminate();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstreamServer.close(() => r()))]);
    upstream.close();
  });
  assert.equal((await fetch(`http://${base}/api/voice/socket`)).status, 426);
  socket = new WebSocket(`ws://${base}/api/voice/socket`, { headers: { Origin: 'https://deployment-test.vercel.app' } });
  await once(socket, 'open');
  const message = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'proxy.auth', pat: 'deployment-test', environment: 'cn-prod', conversation_id: 'conv_deployment' }));
  assert.equal((await message)[0].toString(), 'ready');
});
