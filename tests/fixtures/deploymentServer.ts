import { once } from 'node:events';

async function main() {
// Local adapter for Vercel's file-based HTTP routing. The actual API exports
// and WebSocket server are used; this does not emulate Vercel infrastructure.
if (process.env.TEST_DEPLOYMENT === 'local') {
  await import('../../server/dist/index.js');
} else {
  const { default: server } = await import('../../api/voice/socket.js');
  // The entry starts itself; this local adapter rebinds it to the test port.
  if (!server.listening) await once(server, 'listening');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const { default: health } = await import('../../api/health.js');
  const { default: forward } = await import('../../api/forward/request.js');
  const [socketHttpHandler] = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url === '/api/health') void health(req as never, res as never);
    else if (req.url === '/api/forward/request') void forward(req as never, res as never);
    else socketHttpHandler.call(server, req, res);
  });
  server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('deployment ready'));
}

}
void main();
