import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import './utils/env.js';
import { createVoiceProxy } from './voiceProxy.js';
import { voiceConfig } from './voiceConfig.js';
import { apiBaseUrls, createClient, createTokenIssuer, type ApiLayer, type ApiEnvironment } from './qca/clients.js';
import { dispatch, normalizeQuery } from './qca/dispatch.js';
import { requestScope, sdkResponse, sendError, sendResponse } from './qca/http.js';
import { previewFile, uploadFile } from './qca/transfers.js';
import { relaySse } from './qca/stream.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const app = express();
const PORT = process.env.PORT || 3001;
const API_BASE_URLS = apiBaseUrls('forward');
const CLOUD_API_BASE_URLS = apiBaseUrls('cloud');
const voiceProxy = createVoiceProxy(voiceConfig());
const LOG_DIR = join(process.cwd(), 'logs');
app.use(cors());
app.use(express.json({ limit: '50mb' }));

function proxyLog(level: 'info' | 'warn', message: string, meta: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta });
  if (level === 'warn') console.warn(`[forward-proxy] ${message}`, meta);
  else console.info(`[forward-proxy] ${message}`, meta);
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(join(LOG_DIR, 'forward-proxy.log'), `${line}\n`, 'utf8'); }
  catch { /* Diagnostics must not affect requests. */ }
}
function parseApiEnvironment(value: unknown): ApiEnvironment { return value === 'global-prod' ? value : 'cn-prod'; }
function readBearerToken(req: express.Request, fallback?: unknown) {
  return String(req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? fallback ?? '').trim();
}
function baseUrl(layer: ApiLayer, environment: ApiEnvironment) { return (layer === 'forward' ? API_BASE_URLS : CLOUD_API_BASE_URLS)[environment]; }

function requestHandler(layer: ApiLayer) {
  return async (req: express.Request, res: express.Response) => {
    const startedAt = Date.now();
    const { pat, userId, method = 'GET', path, query, body, idempotencyKey, authMode } = req.body ?? {};
    const environment = parseApiEnvironment(req.body?.environment);
    const token = readBearerToken(req, pat ?? userId);
    const targetPath = String(path ?? '').trim();
    if (!token || !targetPath) { res.status(400).json({ error: { message: 'token and path are required' } }); return; }
    const scope = requestScope(req, res);
    try {
      const issuing = layer === 'forward' && String(method).toUpperCase() === 'POST'
        && /^\/(?:identities\/[^/]+\/)?service_account_tokens$/.test(targetPath);
      const client = issuing ? createTokenIssuer(baseUrl(layer, environment)) : createClient(layer, baseUrl(layer, environment), token, authMode);
      const upstream = await dispatch(client, { method: String(method), path: targetPath, body, query, token, idempotencyKey, signal: scope.signal });
      proxyLog(upstream.ok ? 'info' : 'warn', `${layer} request`, {
        method, environment, path: targetPath, status: upstream.status,
        requestId: upstream.headers.get('x-request-id') || upstream.headers.get('request-id') || upstream.headers.get('x-trace-id') || undefined,
        duration: `${Date.now() - startedAt}ms`,
      });
      await sendResponse(res, upstream);
    } catch (error) { await sendError(res, error, scope.timedOut); }
    finally { scope.dispose(); }
  };
}
app.post('/api/forward/request', requestHandler('forward'));
app.post('/api/cloud/request', requestHandler('cloud'));

function previewHandler(layer: ApiLayer) {
  return async (req: express.Request, res: express.Response) => {
    const token = readBearerToken(req, req.query.pat ?? req.query.userId);
    const fileId = String(req.params.fileId ?? '').trim();
    const environment = parseApiEnvironment(req.query.environment);
    if (!token || !fileId) { res.status(400).json({ error: { message: 'token and fileId are required' } }); return; }
    const scope = requestScope(req, res);
    try {
      const client = createClient(layer, baseUrl(layer, environment), token, req.query.authMode);
      const { content, mimeType } = await previewFile(client, fileId, { signal: scope.signal });
      const bytes = Buffer.from(await content.arrayBuffer());
      res.set({ 'Content-Type': mimeType, 'Cache-Control': 'private, max-age=300' }).send(bytes);
    } catch (error) { await sendError(res, error, scope.timedOut); }
    finally { scope.dispose(); }
  };
}
app.get('/api/forward/files/:fileId/preview', previewHandler('forward'));
app.get('/api/cloud/files/:fileId/preview', previewHandler('cloud'));

app.get('/api/forward/sessions/:sessionId/events/stream', async (req, res) => {
  const startedAt = Date.now();
  const environment = parseApiEnvironment(req.query.environment);
  const token = readBearerToken(req, req.query.pat ?? req.query.userId);
  const sessionId = String(req.params.sessionId ?? '').trim();
  if (!token || !sessionId) { res.status(400).json({ error: { message: 'token and sessionId are required' } }); return; }
  // Streaming has no overall deadline; the SDK bounds opening the HTTP request.
  const scope = requestScope(req, res, 0);
  try {
    const client = createClient('forward', API_BASE_URLS[environment], token, req.query.authMode);
    const upstream = await sdkResponse(client.sessions.events.streamEvents(sessionId,
      { last_event_id: req.header('Last-Event-ID') },
      { signal: scope.signal, query: normalizeQuery({ type: req.query.type, types: req.query.types }) },
    ));
    if (!upstream.ok || !upstream.body) { await sendResponse(res, upstream); return; }
    const requestId = upstream.headers.get('x-request-id') || upstream.headers.get('request-id') || upstream.headers.get('x-trace-id');
    if (requestId) res.setHeader('x-request-id', requestId);
    res.socket?.setNoDelay(true);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await relaySse(upstream.body, res, scope.signal);
    res.end();
    proxyLog('info', 'sse ended', { sessionId, environment, requestId, duration: `${Date.now() - startedAt}ms` });
  } catch (error) { await sendError(res, error); }
  finally { scope.dispose(); }
});

function uploadHandler(layer: ApiLayer) {
  return async (req: express.Request, res: express.Response) => {
    const { pat, environment: rawEnvironment, path, authMode } = req.body ?? {};
    const environment = parseApiEnvironment(rawEnvironment);
    const token = readBearerToken(req, pat);
    if (!token || !path) { res.status(400).json({ error: { message: 'token and path are required' } }); return; }
    const scope = requestScope(req, res);
    try {
      const client = createClient(layer, baseUrl(layer, environment), token, authMode);
      const upstream = await uploadFile(client, path, req.file, req.body, { signal: scope.signal, idempotencyKey: req.get('idempotency-key')?.trim() });
      await sendResponse(res, upstream);
    } catch (error) { await sendError(res, error, scope.timedOut); }
    finally { scope.dispose(); }
  };
}
app.post('/api/cloud/upload', upload.single('file'), uploadHandler('cloud'));
app.post('/api/forward/upload', upload.single('file'), uploadHandler('forward'));
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', forwardApiBaseUrls: API_BASE_URLS, voiceRealtimeProxy: { enabled: voiceProxy.enabled, localOnly: false } });
});
export default app;
if (!process.env.VERCEL) {
  const server = createServer(app);
  voiceProxy.attach(server);
  server.listen(PORT, () => {
    console.log(`Forward quickstart server running on http://localhost:${PORT}`);
    console.log('Forward API targets:', API_BASE_URLS);
  });
}
