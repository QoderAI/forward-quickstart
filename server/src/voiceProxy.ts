import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { RequestHandler } from 'express';
import { WebSocket, WebSocketServer } from 'ws';

export type VoiceEnvironment = 'cn-prod' | 'global-prod';
export interface VoiceConnectionPayload { pat: string; environment: VoiceEnvironment; conversationId: string }
export interface ConnectionKeyStore { issue(payload: VoiceConnectionPayload): string; consume(key: string): VoiceConnectionPayload | null }

interface ConnectionKeyStoreOptions {
  ttlMs?: number;
  now?: () => number;
  randomKey?: () => string;
  scheduleExpiry?: (callback: () => void, delayMs: number) => void;
}

function scheduleExpiry(callback: () => void, delayMs: number) {
  setTimeout(callback, delayMs).unref();
}

export function createConnectionKeyStore({ ttlMs = 30_000, now = Date.now, randomKey = () => randomBytes(32).toString('base64url'), scheduleExpiry: schedule = scheduleExpiry }: ConnectionKeyStoreOptions = {}): ConnectionKeyStore {
  const entries = new Map<string, { payload: VoiceConnectionPayload; expiresAt: number }>();
  return {
    issue(payload) {
      const key = randomKey();
      const entry = { payload, expiresAt: now() + ttlMs };
      entries.set(key, entry);
      schedule(() => {
        if (entries.get(key) === entry) entries.delete(key);
      }, ttlMs);
      return key;
    },
    consume(key) {
      const entry = entries.get(key);
      entries.delete(key);
      return entry && entry.expiresAt >= now() ? entry.payload : null;
    },
  };
}

export function buildRealtimeUrl(baseUrl: string, conversationId: string): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/realtime`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('conversation_id', conversationId);
  return url;
}

export function isAllowedLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function relayCloseCode(code: number, fallback: number): number {
  const protocolCode = code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code);
  return protocolCode || (code >= 3000 && code <= 4999) ? code : fallback;
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number, message: string) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createVoiceProxy(options: {
  baseUrls: Record<VoiceEnvironment, string>;
  enabled?: boolean;
  ttlMs?: number;
}) {
  const enabled = options.enabled ?? true;
  const ttlMs = options.ttlMs ?? 30_000;
  const store = createConnectionKeyStore({ ttlMs });
  const wss = new WebSocketServer({ noServer: true });
  let attached = false;

  const issueConnectionKey: RequestHandler = (req, res) => {
    if (!enabled) {
      res.status(501).json({ error: { message: 'Voice WebSocket proxy is available in local development only' } });
      return;
    }
    if (!isAllowedLocalOrigin(req.headers.origin)) {
      res.status(403).json({ error: { message: 'Voice WebSocket proxy only accepts loopback browser origins' } });
      return;
    }
    const pat = String(req.body?.pat ?? '').trim();
    const environment = req.body?.environment;
    const conversationId = String(req.body?.conversation_id ?? '').trim();
    if (!pat || !conversationId || (environment !== 'cn-prod' && environment !== 'global-prod')) {
      res.status(400).json({ error: { message: 'pat, environment and conversation_id are required' } });
      return;
    }
    res.json({ connection_key: store.issue({ pat, environment, conversationId }), expires_in_ms: ttlMs });
  };

  function attach(server: Server) {
    if (!enabled || attached) return;
    attached = true;
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname !== '/api/voice/socket') {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      if (!isAllowedLocalOrigin(request.headers.origin)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      const payload = store.consume(url.searchParams.get('key') || '');
      if (!payload) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        const upstream = new WebSocket(buildRealtimeUrl(options.baseUrls[payload.environment], payload.conversationId), {
          headers: { Authorization: `Bearer ${payload.pat}` },
        });
        const closePeer = (peer: WebSocket, code = 1011, reason = 'voice proxy closed', fallback = 1011) => {
          if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) peer.close(relayCloseCode(code, fallback), reason);
        };
        client.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        upstream.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });
        client.on('close', (code) => closePeer(upstream, code, 'client closed', 1000));
        upstream.on('close', (code) => closePeer(client, code, 'upstream closed', 1011));
        client.on('error', () => closePeer(upstream));
        upstream.on('error', () => closePeer(client));
      });
    });
  }

  return { enabled, issueConnectionKey, attach };
}
