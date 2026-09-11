import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// Export the server itself so Vercel can deliver HTTP upgrade events:
// https://vercel.com/docs/functions/websockets
const server = createServer((_req, res) => {
  res.writeHead(426, { Upgrade: 'websocket' });
  res.end('WebSocket upgrade required');
});

// Vercel compiles API entries to CommonJS while the server package stays ESM
// ("type": "module"), so statically importing the proxy crashes the function
// with ERR_REQUIRE_ESM (issue #17). Load it dynamically like the other API
// entries, and buffer upgrades that arrive before the proxy has attached.
interface QueuedUpgrade {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
}
const queuedUpgrades: QueuedUpgrade[] = [];
let proxyAttached = false;
server.on('upgrade', (request, socket, head) => {
  if (proxyAttached) return;
  if (new URL(request.url || '/', 'http://localhost').pathname !== '/api/voice/socket') {
    socket.destroy();
    return;
  }
  queuedUpgrades.push({ request, socket, head });
});

void (async () => {
  try {
    const [{ createVoiceProxy }, { voiceConfig }] = await Promise.all([
      import('../../server/src/voiceProxy.js'),
      import('../../server/src/voiceConfig.js'),
    ]);
    createVoiceProxy(voiceConfig()).attach(server);
    proxyAttached = true;
    for (const { request, socket, head } of queuedUpgrades.splice(0)) {
      server.emit('upgrade', request, socket, head);
    }
  } catch (error) {
    console.error('[voice] failed to load realtime proxy:', error);
    for (const { socket } of queuedUpgrades.splice(0)) socket.destroy();
  }
})();

export default server;
