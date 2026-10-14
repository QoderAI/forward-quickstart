import { ForwardClient, ManagedClient, type RequestOptions } from 'qca-sdk';
import { extensionRequest } from './extensions.js';
import { ProxyInputError, sdkResponse, type RawCall } from './http.js';

// The browser owns business DTOs. This is the single cast boundary to SDK
// parameter types; preserve extension fields instead of rebuilding payloads.
const params = <T>(value: unknown): T => value as T;
type RecordData = Record<string, unknown>;
type Handler = (context: { client: ForwardClient; body: RecordData; query: RecordData; options: RequestOptions; token: string; id: string; other: string }) => RawCall;
const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/identities$/, ({ client, query, options }) => client.identities.list(params(query), options)],
  ['POST', /^\/identities$/, ({ client, body, options }) => client.identities.create(params(body), options)],
  ['GET', /^\/identities\/([^\/]+)$/, ({ client, options, id }) => client.identities.retrieve(id, options)],
  ['GET', /^\/templates$/, ({ client, query, options }) => client.templates.list(params(query), options)],
  ['POST', /^\/templates$/, ({ client, body, options }) => client.templates.create(params(body), options)],
  ['GET', /^\/templates\/([^\/]+)$/, ({ client, options, id }) => client.templates.retrieve(id, options)],
  ['GET', /^\/sessions$/, ({ client, query, options }) => client.sessions.list(params(query), options)],
  ['POST', /^\/sessions$/, ({ client, body, options }) => client.sessions.create(params(body), options)],
  ['GET', /^\/sessions\/([^\/]+)$/, ({ client, options, id }) => client.sessions.retrieve(id, options)],
  ['GET', /^\/environments$/, ({ client, query, options }) => client.environments.list(params(query), options)],
  ['POST', /^\/environments$/, ({ client, body, options }) => client.environments.create(params(body), options)],
  ['GET', /^\/environments\/([^\/]+)$/, ({ client, options, id }) => client.environments.retrieve(id, options)],
  ['GET', /^\/vaults$/, ({ client, query, options }) => client.vaults.list(params(query), options)],
  ['POST', /^\/vaults$/, ({ client, body, options }) => client.vaults.create(params(body), options)],
  ['GET', /^\/vaults\/([^\/]+)$/, ({ client, options, id }) => client.vaults.retrieve(id, options)],
  ['GET', /^\/schedules$/, ({ client, query, options }) => client.schedules.list(params(query), options)],
  ['POST', /^\/schedules$/, ({ client, body, options }) => client.schedules.create(params(body), options)],
  ['GET', /^\/schedules\/([^\/]+)$/, ({ client, options, id }) => client.schedules.retrieve(id, options)],
  ['GET', /^\/channels$/, ({ client, query, options }) => client.channels.list(params(query), options)],
  ['POST', /^\/channels$/, ({ client, body, options }) => client.channels.create(params(body), options)],
  ['GET', /^\/channels\/([^\/]+)$/, ({ client, options, id }) => client.channels.retrieve(id, options)],
  ['GET', /^\/batches$/, ({ client, query, options }) => client.batches.list(params(query), options)],
  ['POST', /^\/batches$/, ({ client, body, options }) => client.batches.create(params(body), options)],
  ['GET', /^\/batches\/([^\/]+)$/, ({ client, options, id }) => client.batches.retrieve(id, options)],
  ['DELETE', /^\/identities\/([^\/]+)$/, ({ client, options, id }) => client.identities.delete(id, options)],
  ['DELETE', /^\/environments\/([^\/]+)$/, ({ client, options, id }) => client.environments.delete(id, options)],
  ['DELETE', /^\/vaults\/([^\/]+)$/, ({ client, options, id }) => client.vaults.delete(id, options)],
  ['DELETE', /^\/channels\/([^\/]+)$/, ({ client, options, id }) => client.channels.delete(id, options)],
  ['POST', /^\/templates\/([^\/]+)$/, ({ client, body, options, id }) => client.templates.update(id, params(body), options)],
  ['POST', /^\/environments\/([^\/]+)$/, ({ client, body, options, id }) => client.environments.update(id, params(body), options)],
  ['POST', /^\/schedules\/([^\/]+)$/, ({ client, body, options, id }) => client.schedules.update(id, params(body), options)],
  ['POST', /^\/channels\/([^\/]+)$/, ({ client, body, options, id }) => client.channels.update(id, params(body), options)],
  ['POST', /^\/templates\/([^\/]+)\/archive$/, ({ client, body, options, id }) => client.templates.archive(id, params(body), options)],
  ['POST', /^\/templates\/([^\/]+)\/clone$/, ({ client, body, options, id }) => client.templates.clone(id, params(body), options)],
  ['POST', /^\/sessions\/([^\/]+)\/archive$/, ({ client, body, options, id }) => client.sessions.archive(id, params(body), options)],
  ['POST', /^\/sessions\/([^\/]+)\/cancel$/, ({ client, body, options, id }) => client.sessions.cancel(id, params(body), options)],
  ['POST', /^\/schedules\/([^\/]+)\/archive$/, ({ client, body, options, id }) => client.schedules.archive(id, params(body), options)],
  ['POST', /^\/schedules\/([^\/]+)\/run$/, ({ client, body, options, id }) => client.schedules.run(id, params(body), options)],
  ['POST', /^\/schedules\/([^\/]+)\/pause$/, ({ client, body, options, id }) => client.schedules.pause(id, params(body), options)],
  ['POST', /^\/schedules\/([^\/]+)\/unpause$/, ({ client, body, options, id }) => client.schedules.unpause(id, params(body), options)],
  ['POST', /^\/batches\/([^\/]+)\/cancel$/, ({ client, body, options, id }) => client.batches.cancel(id, params(body), options)],
  ['POST', /^\/environments\/([^\/]+)\/archive$/, ({ client, options, id }) => client.environments.archive(id, options)],
  ['GET', /^\/identities\/([^\/]+)\/templates\/([^\/]+)\/effective$/, ({ client, options, id, other }) => client.identities.configs.getEffective(id, other, options)],
  ['GET', /^\/sessions\/([^\/]+)\/events$/, ({ client, query, options, id }) => client.sessions.events.list(id, params(query), options)],
  ['POST', /^\/sessions\/([^\/]+)\/events$/, ({ client, body, options, id }) => client.sessions.events.send(id, params(body), options)],
  ['POST', /^\/sessions\/([^\/]+)\/resources$/, ({ client, body, options, id }) => client.sessions.resources.add(id, params(body), options)],
  ['GET', /^\/models$/, ({ client, options }) => client.models.list(options)],
  ['GET', /^\/skills$/, ({ client, query, options }) => client.skills.list(params(query), options)],
  ['GET', /^\/skills\/([^\/]+)$/, ({ client, query, options, id }) => client.skills.retrieve(id, params(query), options)],
  ['DELETE', /^\/skills\/([^\/]+)$/, ({ client, options, id }) => client.skills.delete(id, options)],
  ['GET', /^\/files$/, ({ client, query, options }) => client.files.list(params(query), options)],
  ['GET', /^\/files\/([^\/]+)$/, ({ client, options, id }) => client.files.getMetadata(id, options)],
  ['DELETE', /^\/files\/([^\/]+)$/, ({ client, options, id }) => client.files.delete(id, options)],
  ['PUT', /^\/skills\/([^\/]+)$/, ({ client, body, options, id }) => client.skills.update(id, params(body), options)],
  ['GET', /^\/vaults\/([^\/]+)\/credentials$/, ({ client, query, options, id }) => client.vaults.credentials.list(id, params(query), options)],
  ['POST', /^\/vaults\/([^\/]+)\/credentials$/, ({ client, body, options, id }) => client.vaults.credentials.create(id, params(body), options)],
  ['DELETE', /^\/vaults\/([^\/]+)\/credentials\/([^\/]+)$/, ({ client, options, id, other }) => client.vaults.credentials.delete(id, other, options)],
  ['GET', /^\/schedule_runs$/, ({ client, query, options }) => client.scheduleRuns.list(params(query), options)],
  ['GET', /^\/schedule_runs\/([^\/]+)$/, ({ client, query, options, id }) => client.scheduleRuns.retrieve(id, params(query), options)],
  ['GET', /^\/memory_stores\/([^\/]+)\/memories$/, ({ client, query, options, id }) => client.memoryStores.memories.list(id, params(query), options)],
  ['GET', /^\/memory_stores\/([^\/]+)\/memories\/([^\/]+)$/, ({ client, options, id, other }) => client.memoryStores.memories.retrieve(id, other, options)],
  ['POST', /^\/channels\/([^\/]+)\/qr_sessions$/, ({ client, body, options, id }) => client.channels.qrSessions.create(id, params(body), options)],
  ['GET', /^\/qr_sessions\/([^\/]+)$/, ({ client, options, id }) => client.channels.qrSessions.retrieve(id, options)],
  ['GET', /^\/batches\/([^\/]+)\/output$/, ({ client, options, id }) => client.batches.getOutput(id, options)],
  ['GET', /^\/batches\/([^\/]+)\/error$/, ({ client, options, id }) => client.batches.getError(id, options)],
  ['GET', /^\/batches\/([^\/]+)\/tasks$/, ({ client, query, options, id }) => client.batches.tasks.list(id, params(query), options)],
  ['GET', /^\/usage\/identities$/, ({ client, query, options }) => client.usage.listIdentities(params(query), options)],
  ['GET', /^\/usage\/templates$/, ({ client, query, options }) => client.usage.listTemplates(params(query), options)],
  ['POST', /^\/service_account_tokens$/, ({ client, body, options, token }) => client.serviceAccountTokens.create({ ...params<Record<string, unknown>>(body), saKey: token }, options)],
  ['POST', /^\/identities\/([^\/]+)\/service_account_tokens$/, ({ client, body, options, token, id }) => client.identities.serviceAccountTokens.create(id, { ...params<Record<string, unknown>>(body), saKey: token }, options)],
  ['POST', /^\/realtime\/conversations$/, ({ client, body, options }) => client.realtime.conversations.create(params({ ...body, idempotency_key: options.idempotencyKey }), options)],
  ['GET', /^\/realtime\/conversations\/([^\/]+)\/history$/, ({ client, query, options, id }) => client.realtime.conversations.history(id, params(query), options)],

];

export function normalizeQuery(value: unknown): RecordData {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ProxyInputError('query must be an object');
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v != null && v !== ''));
}

export async function dispatch(client: ForwardClient | ManagedClient, input: {
  method: string; path: string; body?: unknown; query?: unknown; token: string; idempotencyKey?: string; signal?: AbortSignal;
}) {
  const { path, token } = input;
  const method = input.method.toUpperCase();
  if (!/^\/(?:[^/?#]+)(?:\/[^/?#]+)*$/.test(path)) throw new ProxyInputError('invalid API path');
  let parts: string[];
  try { parts = path.slice(1).split('/').map(decodeURIComponent); }
  catch { throw new ProxyInputError('invalid path encoding'); }
  if (parts.some(p => p === '.' || p === '..')) throw new ProxyInputError('invalid API path');
  if (input.body != null && (typeof input.body !== 'object' || Array.isArray(input.body))) throw new ProxyInputError('body must be an object');
  const b = (input.body ?? {}) as RecordData;
  const q = normalizeQuery(input.query);
  const beta = Array.isArray(b.tools) && b.tools.some(t => t && typeof t === 'object' && t.type === 'browser_toolset_20260714');
  const o: RequestOptions = { signal: input.signal, idempotencyKey: input.idempotencyKey, query: q,
    ...(beta ? { headers: { 'x-qoder-beta': 'browser-use-2026-07-14' } } : {}),
  };
  if (client instanceof ForwardClient) {
    for (const [verb, pattern, handler] of routes) {
      const match = verb === method ? pattern.exec(path) : null;
      if (match) return sdkResponse(handler({ client, body: b, query: q, options: o, token, id: match[1] ? decodeURIComponent(match[1]) : '', other: match[2] ? decodeURIComponent(match[2]) : '' }));
    }
  } else {
    if (method === 'GET' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'resources') return sdkResponse(client.sessions.resources.list(parts[1], params(q), o));
    if (parts.length === 2 && parts[0] === 'files') {
      if (method === 'GET') return sdkResponse(client.files.getMetadata(parts[1], params(q), o));
      if (method === 'DELETE') return sdkResponse(client.files.delete(parts[1], params(q), o));
    }
  }
  const extension = extensionRequest(client, method, '/' + parts.map(encodeURIComponent).join('/'), b, o);
  if (extension) return sdkResponse(extension);
  throw new ProxyInputError(`Unsupported ${client.mode} operation: ${method} ${path}`, 404);
}
