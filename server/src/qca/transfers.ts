import { toFile, ForwardClient, type ManagedClient, type RequestOptions } from 'qca-sdk';
import { ProxyInputError, sdkResponse } from './http.js';

export async function uploadFile(client: ForwardClient | ManagedClient, path: string, file: Express.Multer.File | undefined, fields: Record<string, unknown>, options: RequestOptions) {
  if (!file) throw new ProxyInputError('file is required');
  const upload = await toFile(file.buffer, file.originalname, { type: file.mimetype });
  let metadata = fields.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { throw new ProxyInputError('metadata must be valid JSON'); }
  }
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) throw new ProxyInputError('metadata must be an object');
  if (path === '/files') {
    const payload = { file: upload, name: fields.name, purpose: typeof fields.purpose === 'string' ? fields.purpose : undefined, metadata };
    return sdkResponse(client instanceof ForwardClient
      ? client.files.upload(payload as Parameters<typeof client.files.upload>[0], options)
      : client.files.upload(payload as Parameters<typeof client.files.upload>[0], options));
  }
  if (path === '/skills') {
    const payload = { files: [upload], metadata };
    return sdkResponse(client instanceof ForwardClient
      ? client.skills.create(payload as Parameters<typeof client.skills.create>[0], options)
      : client.skills.create(payload as Parameters<typeof client.skills.create>[0], options));
  }
  throw new ProxyInputError('Unsupported upload path', 404);
}

export async function previewFile(client: ForwardClient | ManagedClient, fileId: string, options: RequestOptions) {
  const meta = await sdkResponse(client instanceof ForwardClient ? client.files.getMetadata(fileId, options) : client.files.getMetadata(fileId, {}, options));
  const metadata = meta.ok ? await meta.json() as { mime_type?: string } : (await meta.body?.cancel(), undefined);
  // SDK isolates API authorization from the signed storage download request.
  const content = await (client instanceof ForwardClient ? client.files.download(fileId, options) : client.files.download(fileId, {}, options));
  return { content, mimeType: metadata?.mime_type || content.headers.get('content-type') || 'application/octet-stream' };
}
