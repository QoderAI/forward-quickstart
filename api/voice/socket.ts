import { createServer } from 'node:http';
import { createVoiceProxy } from '../../server/src/voiceProxy.js';
import { voiceConfig } from '../../server/src/voiceConfig.js';

// Export the server itself so Vercel can deliver HTTP upgrade events.
const server = createServer((_req, res) => {
  res.writeHead(426, { Upgrade: 'websocket' });
  res.end('WebSocket upgrade required');
});
createVoiceProxy(voiceConfig()).attach(server);
// Node runners that discover servers by intercepting listen() need this call.
// Use an ephemeral port when the entry is started outside that runtime.
server.listen(0);
export default server;
