import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ForwardClient, APIError, RealtimeConnectionClosedError, RealtimeProtocolError, RealtimeServerError, type RealtimeConnection, type RealtimeClientEvent } from 'qca-sdk';
import { clientOptions } from './qca/clients.js';

export type VoiceEnvironment = 'cn-prod' | 'global-prod';

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
  initializationTimeoutMs?: number;
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
        let upstream: RealtimeConnection | undefined;
        let authenticated = false;
        let finished = false;
        let closeRequestId: string | undefined;
        let closeAcknowledged = false;
        let initialization: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        const stop = (code: number, reason: string) => {
          if (finished) return;
          finished = true;
          clearTimeout(authTimer); clearTimeout(initialization); clearTimeout(lifetime);
          // Cancels preparation and ready waits as well as established connections.
          controller.abort();
          upstream?.close();
          if (client.readyState === WebSocket.OPEN) client.close(relayCloseCode(code, 1011), reason);
        };
        const authTimer = setTimeout(() => stop(4408, 'authentication timeout'), options.authTimeoutMs ?? 5000);
        const lifetime = options.maxConnectionMs ? setTimeout(() => stop(1012, 'proxy rotation'), options.maxConnectionMs) : undefined;
        const relay = (event: unknown) => {
          if (finished || client.readyState !== WebSocket.OPEN) return;
          if (client.bufferedAmount > 4 * 1024 * 1024) { stop(1013, 'slow consumer'); return; }
          client.send(JSON.stringify(event), error => { if (error) stop(1011, 'client unavailable'); });
        };
        const connect = async (auth: { pat: string; environment: VoiceEnvironment; authMode?: string; conversation_id: string }) => {
          initialization = setTimeout(() => stop(1011, 'upstream initialization timeout'), options.initializationTimeoutMs ?? 30_000);
          try {
            const sdk = new ForwardClient(clientOptions(options.baseUrls[auth.environment], auth.pat, auth.authMode));
            const connection = await sdk.realtime.connect({ conversationId: auth.conversation_id, signal: controller.signal,
              handshakeTimeout: 15_000, readyTimeout: 30_000, sendTimeout: 5000, closeTimeout: 5000,
            });
            if (finished) { connection.close(); return; }
            upstream = connection;
            clearTimeout(initialization);
            // Includes pre-ready events and ready itself. Exactly one consumer.
            for await (const event of connection) {
              if (event.type === 'connection.closed' && event.payload.request_id === closeRequestId) closeAcknowledged = true;
              relay(event);
            }
            // SDK iteration ends normally for both 1000 and 1001. Recover an
            // unexpected end (including server shutdown) unless close was acked.
            stop(closeAcknowledged ? 1000 : 1011, 'upstream closed');
          } catch (error) {
            if (finished) return;
            if (!upstream && error instanceof RealtimeServerError) relay(error.event);
            if (error instanceof APIError && error.status) {
              stop(error.status === 401 ? 4401 : error.status === 403 ? 4403 : error.status === 404 ? 4404 : 1011, 'upstream rejected connection');
            } else if (error instanceof RealtimeConnectionClosedError) stop(relayCloseCode(error.closeCode, 1011), 'upstream closed');
            else if (error instanceof RealtimeProtocolError) stop(error.code === 'queue_overflow' ? 1013 : 1002, 'upstream protocol error');
            else stop(1011, 'upstream unavailable');
          }
        };
        client.on('message', (data, binary) => {
          if (finished || client.readyState !== WebSocket.OPEN) return;
          if (authenticated) {
            if (!upstream) { stop(4400, 'upstream not ready'); return; }
            try {
              if (binary) throw new Error('JSON text frames required');
              const event = JSON.parse(data.toString()) as RealtimeClientEvent;
              // SDK bounds this send queue. Do not add a second unbounded queue.
              // connection.close retains the browser request_id and acknowledgement.
              void upstream.sendEvent(event).catch(() => stop(1011, 'upstream send failed'));
              if (event.type === 'connection.close') closeRequestId = String(event.payload.request_id);
            } catch { stop(4400, 'invalid client event'); }
            return;
          }
          let auth;
          try { auth = JSON.parse(data.toString()); } catch { stop(4400, 'invalid authentication'); return; }
          if (binary || data.toString().length > 16384 || auth?.type !== 'proxy.auth' || typeof auth.pat !== 'string' || !auth.pat.trim() || /[\r\n]/.test(auth.pat) || typeof auth.conversation_id !== 'string' || !auth.conversation_id.trim() || !['cn-prod', 'global-prod'].includes(auth.environment)
            || (auth.authMode !== undefined && !['pat', 'service-account'].includes(auth.authMode))) {
            stop(4400, 'invalid authentication'); return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          void connect(auth);
        });
        client.on('close', () => stop(1000, 'client closed'));
        client.on('error', () => stop(1011, 'client error'));
      });
    });
  }
  return { enabled, attach };
}
