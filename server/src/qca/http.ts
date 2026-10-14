import type { Request, Response as ExpressResponse } from 'express';
import { APIError, APIConnectionError, APIConnectionTimeoutError, QoderError } from 'qca-sdk';

export class ProxyInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface RawCall { asResponse(): Promise<Response> }

// SDK errors retain the original wire response, including non-JSON gateway errors.
export async function sdkResponse(call: RawCall): Promise<Response> {
  try { return await call.asResponse(); }
  catch (error) {
    if (error instanceof APIError && error.response) return error.response;
    throw error;
  }
}

export async function sendResponse(res: ExpressResponse, upstream: Response) {
  const body = await upstream.text();
  const id = upstream.headers.get('x-request-id') || upstream.headers.get('request-id') || upstream.headers.get('x-trace-id');
  if (id) res.setHeader('x-request-id', id);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) res.setHeader('retry-after', retryAfter);
  res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(body);
}

export async function sendError(res: ExpressResponse, error: unknown, timedOut = false) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.end(); return; }
  if (error instanceof APIError && error.response) { await sendResponse(res, error.response); return; }
  const status = timedOut || error instanceof APIConnectionTimeoutError ? 504
    : error instanceof ProxyInputError ? error.status
    : error instanceof APIConnectionError ? 502
    : error instanceof QoderError ? 400 : 502;
  res.status(status).json({ error: { message: timedOut ? 'QCA request timed out' : error instanceof Error ? error.message : 'QCA proxy error' } });
}

export function requestScope(req: Request, res: ExpressResponse, timeout = 30_000) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = timeout ? setTimeout(() => { timedOut = true; abort(); }, timeout) : undefined;
  req.once('aborted', abort);
  res.once('close', abort);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() { clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); controller.abort(); },
  };
}
