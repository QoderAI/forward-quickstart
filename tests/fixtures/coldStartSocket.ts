import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createNetServer, createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

// Cold-start scenario for the Vercel voice entry: an upgrade reaches the entry
// before its dynamically imported proxy has attached. Run as a subprocess so
// the entry module is evaluated fresh; prints `coldstart ok` on success.
async function main() {
  const upstreamServer = createServer();
  const upstream = new WebSocketServer({ server: upstreamServer });
  upstream.on('connection', (socket, request) => {
    if (request.headers.authorization !== 'Bearer coldstart-test'
      || request.url !== '/api/v1/forward/realtime?conversation_id=conv_coldstart') {
      socket.close(1011, 'unexpected upstream request');
      throw new Error(`unexpected upstream request: ${request.url}`);
    }
    socket.send('ready');
  });
  upstreamServer.listen(0, '127.0.0.1'); await once(upstreamServer, 'listening');
  process.env.VERCEL = '1';
  process.env.VERCEL_URL = 'coldstart-test.vercel.app';
  process.env.CN_PROD_FORWARD_API_BASE_URL = `http://127.0.0.1:${(upstreamServer.address() as import('node:net').AddressInfo).port}/api/v1/forward`;
  // Real socket pair so the relayed handshake and frames travel over the wire.
  const netServer = createNetServer();
  let clientSocket: Socket | undefined;
  const serverSocket = await new Promise<Socket>(resolve => {
    netServer.on('connection', socket => resolve(socket));
    netServer.listen(0, '127.0.0.1', () => {
      clientSocket = createConnection((netServer.address() as import('node:net').AddressInfo).port, '127.0.0.1');
    });
  });
  const { default: server } = await import('../../api/voice/socket.js');
  const upgrade = {
    method: 'GET',
    url: '/api/voice/socket',
    headers: {
      host: 'coldstart-test.vercel.app',
      origin: 'https://coldstart-test.vercel.app',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': randomBytes(16).toString('base64'),
      'sec-websocket-version': '13',
    },
  };
  // The proxy import is still in flight here, which is exactly the cold-start
  // window being exercised.
  server.emit('upgrade', upgrade, serverSocket, Buffer.alloc(0));
  // Queued instead of processed: the proxy has not attached yet, so the
  // handshake response is not written synchronously.
  if (serverSocket.writableLength !== 0) throw new Error('upgrade was processed before the proxy attached');
  console.log('coldstart queued');
  const chunks: Buffer[] = [];
  clientSocket!.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(clientSocket!, 'data');
  if (!/^HTTP\/1\.1 101/.test(Buffer.concat(chunks).toString())) throw new Error('missing 101 handshake for queued upgrade');
  console.log('coldstart handshake 101');
  const auth = Buffer.from(JSON.stringify({ type: 'proxy.auth', pat: 'coldstart-test', environment: 'cn-prod', conversation_id: 'conv_coldstart' }));
  if (auth.length > 125) throw new Error('auth frame does not fit a single-byte length');
  const mask = randomBytes(4);
  clientSocket!.write(Buffer.concat([
    Buffer.from([0x81, 0x80 | auth.length]),
    mask,
    Buffer.from(auth.map((byte, index) => byte ^ mask[index % 4])),
  ]));
  // The 'ready' event relayed from upstream completes the queued connection.
  await once(clientSocket!, 'data');
  if (!Buffer.concat(chunks).toString().includes('ready')) throw new Error('queued upgrade did not relay the ready event');
  console.log('coldstart relay ready');
  clientSocket!.destroy();
  serverSocket.destroy();
  await new Promise<void>(r => netServer.close(() => r()));
  for (const peer of upstream.clients) peer.terminate();
  await new Promise<void>(r => upstreamServer.close(() => r()));
  upstream.close();
  server.close(() => {});
  console.log('coldstart ok');
}

main().catch(error => {
  console.error(`coldstart fail: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
