import type { ForwardClient, ManagedClient, RequestOptions } from 'qca-sdk';

// Explicit compatibility routes only. New SDK resources belong in dispatch.ts.
const forwardExtensions = [
  /^GET \/resources$/,
  /^POST \/resources\/registry$/,
  /^DELETE \/resources\/[^/]+$/,
  /^POST \/vaults\/[^/]+(?:\/archive)?$/,
  /^DELETE \/schedules\/[^/]+$/,
];

export function extensionRequest(client: ForwardClient | ManagedClient, method: string, path: string, body: unknown, options: RequestOptions) {
  // files.download() fetches bytes; this endpoint must return the signed URL DTO.
  const signedUrl = method === 'GET' && /^\/files\/[^/]+\/content$/.test(path);
  if (!signedUrl && !(client.mode === 'forward' && forwardExtensions.some(pattern => pattern.test(`${method} ${path}`)))) return undefined;
  return client.request({ method, path: path.slice(1), ...options, ...(method === 'POST' ? { body } : {}) });
}
