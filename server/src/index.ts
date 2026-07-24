import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import './utils/env.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3001;
type ForwardApiEnvironment = 'cn-prod' | 'global-prod';

const DEFAULT_API_BASE_URLS: Record<ForwardApiEnvironment, string> = {
  'cn-prod': process.env.CN_PROD_FORWARD_API_BASE_URL?.trim() || 'https://api.qoder.com.cn/api/v1/forward',
  'global-prod': process.env.GLOBAL_PROD_FORWARD_API_BASE_URL?.trim() || 'https://api.qoder.com/api/v1/forward',
};
const API_BASE_URLS = Object.fromEntries(
  Object.entries(DEFAULT_API_BASE_URLS).map(([key, value]) => [key, value.replace(/\/+$/, '')]),
) as Record<ForwardApiEnvironment, string>;
const DEFAULT_CLOUD_API_BASE_URLS: Record<ForwardApiEnvironment, string> = {
  'cn-prod': process.env.CN_PROD_CLOUD_API_BASE_URL?.trim() || 'https://api.qoder.com.cn/api/v1/cloud',
  'global-prod': process.env.GLOBAL_PROD_CLOUD_API_BASE_URL?.trim() || 'https://api.qoder.com/api/v1/cloud',
};
const CLOUD_API_BASE_URLS = Object.fromEntries(
  Object.entries(DEFAULT_CLOUD_API_BASE_URLS).map(([key, value]) => [key, value.replace(/\/+$/, '')]),
) as Record<ForwardApiEnvironment, string>;
const LOG_DIR = join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'forward-proxy.log');

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function proxyLog(level: 'info' | 'warn', message: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
  if (level === 'warn') console.warn(`[forward-proxy] ${message}`, meta ?? {});
  else console.info(`[forward-proxy] ${message}`, meta ?? {});
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // File logging is diagnostic-only; console logging still works if writing fails.
  }
}

function nowMs() {
  return Date.now();
}

function requestMs(startedAt: number) {
  return `${Date.now() - startedAt}ms`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function summarizeEventsBody(text: string) {
  const data = safeJsonParse(text);
  if (!data || typeof data !== 'object') return undefined;
  const events = (data as { data?: unknown }).data;
  if (!Array.isArray(events)) return undefined;
  const types = new Map<string, number>();
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = String((event as { type?: unknown }).type ?? 'unknown');
    types.set(type, (types.get(type) ?? 0) + 1);
  }
  return {
    count: events.length,
    types: Object.fromEntries(types.entries()),
    last: events.length > 0 && typeof events[events.length - 1] === 'object'
      ? {
          id: String((events[events.length - 1] as { id?: unknown }).id ?? ''),
          type: String((events[events.length - 1] as { type?: unknown }).type ?? ''),
          turnId: String((events[events.length - 1] as { turn_id?: unknown }).turn_id ?? ''),
        }
      : undefined,
  };
}

function summarizeTemplateBody(body: unknown) {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const countArray = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const countObject = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
    environmentId: typeof record.environment_id === 'string' ? record.environment_id : undefined,
    hasSystem: typeof record.system === 'string' && record.system.length > 0,
    toolsCount: countArray(record.tools),
    mcpServersCount: countArray(record.mcp_servers),
    skillsCount: countArray(record.skills),
    vaultsCount: countArray(record.vault_ids),
    filesCount: countObject(record.files),
    environmentVariablesCount: countObject(record.environment_variables),
  };
}

function summarizeSseFrame(frame: string) {
  const lines = frame.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  const idLine = lines.find((line) => line.startsWith('id:'))?.slice(3).trim();
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const data = safeJsonParse(dataLines.join('\n'));
  if (!data || typeof data !== 'object') {
    return { id: idLine, type: eventName, rawData: dataLines.length > 0 };
  }
  const record = data as Record<string, unknown>;
  const delta = record.delta as Record<string, unknown> | undefined;
  return {
    id: String(record.id ?? idLine ?? ''),
    type: String(record.type ?? eventName ?? ''),
    turnId: String(record.turn_id ?? ''),
    toolUseId: String(record.tool_use_id ?? record.custom_tool_use_id ?? record.mcp_tool_use_id ?? record.tool_call_id ?? ''),
    ...(delta ? { deltaType: String(delta.type ?? ''), deltaPreview: String(delta.thinking ?? delta.text ?? '').slice(0, 60) } : {}),
  };
}

// Detect whether an SSE frame carries a terminal session event. The upstream keeps
// the stream open with heartbeat frames after the agent goes idle, so the proxy must
// close proactively once a terminal event is forwarded to avoid a ~10min hang.
function isTerminalSseFrame(frame: string): boolean {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const data = safeJsonParse(dataLines.join('\n'));
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  const type = String(record.type ?? '');
  if (
    type === 'session.completed' ||
    type === 'session.error' ||
    type === 'session.cancelled' ||
    type === 'session.canceled' ||
    type === 'session.status_terminated' ||
    type === 'session.thread_status_idle'
  ) return true;
  // session.status_idle is terminal unless the agent is waiting for a tool
  // confirmation (requires_action), in which case the client reconnects.
  if (type === 'session.status_idle') {
    const stopReason = record.stop_reason as { type?: string } | undefined;
    return stopReason?.type !== 'requires_action';
  }
  return false;
}

function parseApiEnvironment(value: unknown): ForwardApiEnvironment {
  if (value === 'cn-prod' || value === 'global-prod') return value;
  return 'cn-prod';
}

function buildForwardUrl(apiEnvironment: ForwardApiEnvironment, path: string, query?: Record<string, unknown>) {
  if (!path.startsWith('/')) {
    throw new Error('path must start with /');
  }
  const url = new URL(`${API_BASE_URLS[apiEnvironment]}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

app.post('/api/forward/request', async (req, res) => {
  const startedAt = nowMs();
  const {
    pat,
    userId,
    method = 'GET',
    path,
    query,
    body,
    idempotencyKey,
    environment,
  } = req.body ?? {};

  const apiEnvironment = parseApiEnvironment(environment);
  const authToken = String(pat ?? userId ?? '').trim();
  const targetPath = String(path ?? '').trim();
  if (!authToken || !targetPath) {
    res.status(400).json({ error: { message: 'pat and path are required' } });
    return;
  }

  try {
    const url = buildForwardUrl(apiEnvironment, targetPath, query);
    const forwardMethod = String(method).toUpperCase();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${authToken}`,
    };
    let payload: string | undefined;
    if (!['GET', 'HEAD'].includes(forwardMethod)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
    }
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);

    const upstream = await fetch(url, {
      method: forwardMethod,
      headers,
      body: payload,
    });
    const text = await upstream.text();
    const upstreamRequestId = upstream.headers.get('x-request-id') || upstream.headers.get('x-trace-id');
    if (upstreamRequestId) res.setHeader('x-request-id', upstreamRequestId);
    if (!upstream.ok) {
      let bodyRequestId = '';
      let rawBody = '';
      try {
        const data = text ? JSON.parse(text) : null;
        bodyRequestId = data?.request_id || data?.requestId || data?.error?.request_id || data?.error?.requestId || '';
      } catch {
        rawBody = text.slice(0, 1000);
      }
      proxyLog('warn', 'upstream error', {
        method: forwardMethod,
        environment: apiEnvironment,
        path: targetPath,
        status: upstream.status,
        requestId: upstreamRequestId || bodyRequestId || undefined,
        ...(rawBody ? { rawResponse: rawBody } : {}),
      });
    }
    if (targetPath.includes('/templates')) {
      proxyLog('info', 'request templates', {
        method: forwardMethod,
        environment: apiEnvironment,
        path: targetPath,
        status: upstream.status,
        bodySummary: summarizeTemplateBody(body),
        upstreamBody: upstream.status >= 400 ? safeJsonParse(text) : undefined,
      });
    }
    if (targetPath.includes('/events')) {
      proxyLog('info', 'request events', {
        method: forwardMethod,
        environment: apiEnvironment,
        path: targetPath,
        query: query ?? undefined,
        upstreamSearch: url.search || undefined,
        status: upstream.status,
        requestId: upstreamRequestId || undefined,
        duration: requestMs(startedAt),
        summary: summarizeEventsBody(text),
      });
    }
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Forward proxy error',
      },
    });
  }
});

app.post('/api/cloud/request', async (req, res) => {
  const startedAt = nowMs();
  const {
    pat,
    userId,
    method = 'GET',
    path,
    query,
    body,
    environment,
  } = req.body ?? {};

  const apiEnvironment = parseApiEnvironment(environment);
  const authToken = String(pat ?? userId ?? '').trim();
  const targetPath = String(path ?? '').trim();
  if (!authToken || !targetPath) {
    res.status(400).json({ error: { message: 'pat and path are required' } });
    return;
  }

  try {
    const url = new URL(`${CLOUD_API_BASE_URLS[apiEnvironment]}${targetPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value == null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const forwardMethod = String(method).toUpperCase();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${authToken}`,
    };
    let payload: string | undefined;
    if (!['GET', 'HEAD'].includes(forwardMethod)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
    }

    const upstream = await fetch(url, {
      method: forwardMethod,
      headers,
      body: payload,
    });
    const text = await upstream.text();
    const upstreamRequestId = upstream.headers.get('x-request-id') || upstream.headers.get('x-trace-id');
    if (upstreamRequestId) res.setHeader('x-request-id', upstreamRequestId);
    proxyLog(upstream.ok ? 'info' : 'warn', 'cloud request', {
      method: forwardMethod,
      environment: apiEnvironment,
      path: targetPath,
      status: upstream.status,
      requestId: upstreamRequestId || undefined,
      duration: requestMs(startedAt),
    });
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Cloud proxy error',
      },
    });
  }
});

// 代理 Cloud 文件内容：客户端无法直接 fetch OSS 预签名 URL（CORS + content-disposition=attachment），
// 由服务端获取预签名 URL 后 fetch 图片数据，以正确的 Content-Type 返回给浏览器内联显示。
app.get('/api/cloud/files/:fileId/preview', async (req, res) => {
  const authToken = String(req.query.pat ?? req.query.userId ?? '').trim();
  const fileId = String(req.params.fileId ?? '').trim();
  const environment = parseApiEnvironment(req.query.environment);
  if (!authToken || !fileId) {
    res.status(400).json({ error: { message: 'pat and fileId are required' } });
    return;
  }
  try {
    // 1. 获取文件元数据（拿 mime_type 和 filename）
    const fileMetaUrl = new URL(`${CLOUD_API_BASE_URLS[environment]}/files/${encodeURIComponent(fileId)}`);
    const fileMetaRes = await fetch(fileMetaUrl, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${authToken}` },
    });
    let fileMeta: { mime_type?: string; filename?: string } | null = null;
    if (fileMetaRes.ok) {
      fileMeta = await fileMetaRes.json() as { mime_type?: string; filename?: string };
    }
    // 2. 获取预签名下载 URL
    const contentUrl = new URL(`${CLOUD_API_BASE_URLS[environment]}/files/${encodeURIComponent(fileId)}/content`);
    const contentRes = await fetch(contentUrl, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${authToken}` },
    });
    if (!contentRes.ok) {
      res.status(contentRes.status).json({ error: { message: `Cloud API ${contentRes.status}` } });
      return;
    }
    const { url } = await contentRes.json() as { url?: string };
    if (!url) {
      res.status(404).json({ error: { message: 'No download URL returned' } });
      return;
    }
    // 3. fetch 图片数据并透传给客户端（去掉 attachment 头，让浏览器内联显示）
    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      res.status(imgRes.status).json({ error: { message: `OSS ${imgRes.status}` } });
      return;
    }
    // 优先使用文件元数据的 mime_type；OSS 返回的 content-type 通常是 application/octet-stream
    const contentType = fileMeta?.mime_type
      || imgRes.headers.get('content-type')
      || 'application/octet-stream';
    const buf = Buffer.from(await imgRes.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=300',
    });
    res.end(buf);
  } catch (err) {
    res.status(502).json({
      error: { message: err instanceof Error ? err.message : 'Preview proxy error' },
    });
  }
});

app.get('/api/forward/sessions/:sessionId/events/stream', async (req, res) => {
  const startedAt = nowMs();
  const apiEnvironment = parseApiEnvironment(req.query.environment);
  const authToken = String(req.query.pat ?? req.query.userId ?? '').trim();
  const sessionId = String(req.params.sessionId ?? '').trim();
  if (!authToken || !sessionId) {
    res.status(400).json({ error: { message: 'pat and sessionId are required' } });
    return;
  }

  try {
    const url = buildForwardUrl(apiEnvironment, `/sessions/${encodeURIComponent(sessionId)}/events/stream`, {
      type: req.query.type,
      types: req.query.types,
    });
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${authToken}`,
    };
    const lastEventId = req.header('Last-Event-ID');
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;

    const upstream = await fetch(url, { headers });
    const upstreamRequestId = upstream.headers.get('x-request-id') || upstream.headers.get('x-trace-id');
    if (upstreamRequestId) res.setHeader('x-request-id', upstreamRequestId);
    proxyLog('info', 'sse open', {
      sessionId,
      environment: apiEnvironment,
      status: upstream.status,
      requestId: upstreamRequestId || undefined,
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      proxyLog('warn', 'sse upstream error', {
        sessionId,
        environment: apiEnvironment,
        status: upstream.status,
        requestId: upstreamRequestId || undefined,
        body: text.slice(0, 500),
      });
      res.status(upstream.status).send(text);
      return;
    }

    // Disable buffering for SSE: Nagle off + no proxy buffering
    res.socket?.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let frameCount = 0;
    req.on('close', () => {
      void reader.cancel().catch(() => undefined);
      proxyLog('info', 'sse client closed', {
        sessionId,
        environment: apiEnvironment,
        requestId: upstreamRequestId || undefined,
        frames: frameCount,
        duration: requestMs(startedAt),
      });
    });
    let terminal = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (!frame.trim()) continue;
        frameCount += 1;
        proxyLog('info', 'sse event', {
          sessionId,
          environment: apiEnvironment,
          requestId: upstreamRequestId || undefined,
          frame: frameCount,
          ...summarizeSseFrame(frame),
        });
        if (isTerminalSseFrame(frame)) terminal = true;
      }
      res.write(Buffer.from(value));
      // Force flush to ensure client receives SSE frames immediately
      if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
      }
      // Close proactively after forwarding a terminal event, otherwise the upstream
      // keeps the connection alive with heartbeats until its ~10min timeout and the
      // client stays stuck in the streaming state.
      if (terminal) {
        proxyLog('info', 'sse terminal event, closing', {
          sessionId,
          environment: apiEnvironment,
          requestId: upstreamRequestId || undefined,
          frames: frameCount,
          duration: requestMs(startedAt),
        });
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (buffer.trim()) {
      frameCount += 1;
      proxyLog('info', 'sse event', {
        sessionId,
        environment: apiEnvironment,
        requestId: upstreamRequestId || undefined,
        frame: frameCount,
        ...summarizeSseFrame(buffer),
      });
    }
    proxyLog('info', 'sse upstream ended', {
      sessionId,
      environment: apiEnvironment,
      requestId: upstreamRequestId || undefined,
      frames: frameCount,
      duration: requestMs(startedAt),
    });
    res.end();
  } catch (err) {
    proxyLog('warn', 'sse proxy error', {
      sessionId,
      environment: apiEnvironment,
      message: err instanceof Error ? err.message : String(err),
      duration: requestMs(startedAt),
    });
    if (!res.headersSent) {
      res.status(502).json({
        error: {
          message: err instanceof Error ? err.message : 'Forward stream proxy error',
        },
      });
    } else {
      res.end();
    }
  }
});

// ─── Multipart upload proxy for Cloud API (Skills/Files) ──────────

app.post('/api/cloud/upload', upload.single('file'), async (req, res) => {
  const startedAt = nowMs();
  const { pat, environment, path: targetPath } = req.body ?? {};
  const apiEnvironment = parseApiEnvironment(environment);
  const authToken = String(pat ?? '').trim();
  const target = String(targetPath ?? '').trim();

  if (!authToken || !target) {
    res.status(400).json({ error: { message: 'pat and path are required' } });
    return;
  }

  try {
    const url = new URL(`${CLOUD_API_BASE_URLS[apiEnvironment]}${target}`);
    const formData = new FormData();

    // Forward file if present
    if (req.file) {
      formData.append('file', new Blob([req.file.buffer as unknown as BlobPart], { type: req.file.mimetype }), req.file.originalname);
    }

    // Forward other body fields
    for (const [key, value] of Object.entries(req.body ?? {})) {
      if (key !== 'pat' && key !== 'environment' && key !== 'path') {
        formData.append(key, String(value));
      }
    }

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    const text = await upstream.text();
    const upstreamRequestId = upstream.headers.get('x-request-id') || upstream.headers.get('x-trace-id');
    if (upstreamRequestId) res.setHeader('x-request-id', upstreamRequestId);

    proxyLog(upstream.ok ? 'info' : 'warn', 'cloud upload', {
      environment: apiEnvironment,
      path: target,
      status: upstream.status,
      requestId: upstreamRequestId || undefined,
      duration: requestMs(startedAt),
      fileSize: req.file?.size,
    });

    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({
      error: { message: err instanceof Error ? err.message : 'Cloud upload proxy error' },
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', forwardApiBaseUrls: API_BASE_URLS });
});

export default app;

// Vercel imports the Express app as a serverless function. Keep the listener
// for the existing local development and standalone production commands.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Forward quickstart server running on http://localhost:${PORT}`);
    console.log('Forward API targets:', API_BASE_URLS);
  });
}
