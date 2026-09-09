import { createServer } from 'node:http';
import { createVoiceProxy } from '../../server/src/voiceProxy.js';
import { voiceConfig } from '../../server/src/voiceConfig.js';

// Export the server itself so Vercel can deliver HTTP upgrade events.
const server = createServer((_req, res) => {
  res.writeHead(426, { Upgrade: 'websocket' });
  res.end('WebSocket upgrade required');
});
createVoiceProxy(voiceConfig()).attach(server);
export default server;
