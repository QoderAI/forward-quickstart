import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export type VoiceEnvironment = 'cn-prod' | 'global-prod';

export function buildRealtimeUrl(baseUrl: string, conversationId: string): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/realtime`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('conversation_id', conversationId);
  return url;
}

export function isAllowedLocalOrigin(origin: string | undefined): boolean {
  try {
    const url = new URL(origin || '');
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export function relayCloseCode(code: number, fallback: number): number {
  return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : fallback;
}

export function createVoiceProxy(options: {
  baseUrls: Record<VoiceEnvironment, string>;
  allowedOrigins?: string[];
  allowLocal?: boolean;
  authTimeoutMs?: number;
  maxConnectionMs?: number;
}) {
  const allowedOrigins = new Set(options.allowedOrigins || []);
  const enabled = (options.allowLocal ?? true) || allowedOrigins.size > 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let attached = false;
  function attach(server: Server) {
    if (attached) return;
    attached = true;
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', 'http://localhost');
      const origin = request.headers.origin;
      // Vercel reports only one production domain in VERCEL_PROJECT_PRODUCTION_URL
      // even when several are bound to the project, so additionally accept
      // same-origin requests whose browser Origin matches the routed Host.
      const host = request.headers.host;
      const allowed = !!origin && (allowedOrigins.has(origin)
        || (typeof host === 'string' && origin === `https://${host}`)
        || ((options.allowLocal ?? true) && isAllowedLocalOrigin(origin)));
      const status = url.pathname !== '/api/voice/socket' ? 404 : !enabled || !allowed ? 403 : url.search ? 400 : 0;
      if (status) {
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        let upstream: WebSocket | undefined;
        let authenticated = false;
        const close = (peer: WebSocket | undefined, code: number, reason: string) => {
          if (peer?.readyState === WebSocket.CONNECTING) peer.terminate();
          else if (peer?.readyState === WebSocket.OPEN) peer.close(relayCloseCode(code, 1011), reason);
        };
        const authTimer = setTimeout(() => close(client, 4408, 'authentication timeout'), options.authTimeoutMs ?? 5000);
        const lifetime = options.maxConnectionMs ? setTimeout(() => {
          close(upstream, 1000, 'proxy rotation');
          close(client, 1012, 'proxy rotation');
        }, options.maxConnectionMs) : undefined;
        const relay = (peer: WebSocket | undefined, data: import('ws').RawData, binary: boolean) => {
          if (peer?.readyState !== WebSocket.OPEN) return;
          if (peer.bufferedAmount > 4 * 1024 * 1024) {
            close(client, 1013, 'slow consumer'); close(upstream, 1013, 'slow consumer');
          } else peer.send(data, { binary });
        };
        client.on('message', (data, binary) => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (authenticated) {
            if (upstream?.readyState !== WebSocket.OPEN) { close(client, 4400, 'upstream not ready'); return; }
            relay(upstream, data, binary); return;
          }
          let auth;
          try { auth = JSON.parse(data.toString()); } catch { close(client, 4400, 'invalid authentication'); return; }
          if (binary || data.toString().length > 16384 || auth?.type !== 'proxy.auth' || typeof auth.pat !== 'string' || !auth.pat.trim() || /[\r\n]/.test(auth.pat) || typeof auth.conversation_id !== 'string' || !auth.conversation_id.trim() || !['cn-prod', 'global-prod'].includes(auth.environment)) {
            close(client, 4400, 'invalid authentication'); return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          upstream = new WebSocket(buildRealtimeUrl(options.baseUrls[auth.environment as VoiceEnvironment], auth.conversation_id), {
            headers: { Authorization: `Bearer ${auth.pat}` }, handshakeTimeout: 15000, maxPayload: 1024 * 1024,
          });
          upstream.on('message', (message, isBinary) => relay(client, message, isBinary));
          upstream.on('unexpected-response', (_req, response) => {
            const status = response.statusCode;
            response.resume();
            close(client, status === 401 ? 4401 : status === 403 ? 4403 : status === 404 ? 4404 : 1011, 'upstream rejected connection');
            upstream?.terminate();
          });
          upstream.on('error', () => close(client, 1011, 'upstream unavailable'));
          upstream.on('close', code => close(client, code === 1000 ? 1000 : relayCloseCode(code, 1011), 'upstream closed'));
        });
        client.on('close', () => {
          clearTimeout(authTimer); clearTimeout(lifetime);
          close(upstream, 1000, 'client closed');
        });
        client.on('error', () => close(upstream, 1011, 'client error'));
      });
    });
  }
  return { enabled, attach };
}
