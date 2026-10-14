import { afterEach, expect, test, vi } from 'vitest';
import { loadArtifactPreview } from './artifactPreview';
import { ForwardApiError, type ForwardContext } from './forwardApi';

const ctx: ForwardContext = { pat: 'sat_test', environment: 'cn-prod', authMode: 'service-account' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('SA artifacts remain previewable when metadata is 404 but content is authorized', async () => {
  const fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/preview?')
    ? new Response('png bytes', { headers: { 'content-type': 'image/png' } })
    : Response.json({ error: { message: 'File not found' } }, { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const result = await loadArtifactPreview(ctx, 'artifact_1');
  expect(result.file).toBeNull();
  expect(result.image?.type).toBe('image/png');
  expect(await result.image?.text()).toBe('png bytes');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/cloud/'))).toBe(false);
});

test.each([401, 403])('metadata authorization error %s does not trigger a content probe', async status => {
  const fetch = vi.fn(async () => Response.json({ error: { message: 'Forbidden' } }, { status }));
  vi.stubGlobal('fetch', fetch);
  await expect(loadArtifactPreview(ctx, 'artifact_1')).rejects.toMatchObject({ status });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('an authorized metadata-less non-image remains a download card', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('/preview?')
    ? new Response('report', { headers: { 'content-type': 'text/plain' } })
    : Response.json({ error: {} }, { status: 404 })));
  expect(await loadArtifactPreview(ctx, 'artifact_1')).toEqual({ file: null, image: null });
});

test('content authorization errors are preserved after missing metadata', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => Response.json({ error: {} }, { status: String(url).includes('/preview?') ? 403 : 404 })));
  const result = loadArtifactPreview(ctx, 'artifact_1');
  await expect(result).rejects.toBeInstanceOf(ForwardApiError);
  await expect(result).rejects.toMatchObject({ status: 403 });
});

test('known image filenames remain previewable when storage returns a generic MIME type', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('/preview?')
    ? new Response('png bytes', { headers: { 'content-type': 'application/octet-stream' } })
    : Response.json({ id: 'artifact_1', filename: 'chart.png', mime_type: 'application/octet-stream' })));
  const result = await loadArtifactPreview(ctx, 'artifact_1');
  expect(result.file?.filename).toBe('chart.png');
  expect(await result.image?.text()).toBe('png bytes');
});

test.each([
  ['image/png', [137, 80, 78, 71, 13, 10, 26, 10]],
  ['image/jpeg', [255, 216, 255, 224]],
  ['image/gif', [...new TextEncoder().encode('GIF89a')]],
  ['image/webp', [...new TextEncoder().encode('RIFF0000WEBP')]],
  ['image/bmp', [66, 77]],
  ['image/avif', [0, 0, 0, 24, ...new TextEncoder().encode('ftypavif')]],
])('metadata-less %s artifacts are identified from bytes when storage omits the MIME type', async (mimeType, header) => {
  const bytes = new Uint8Array(header);
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('/preview?')
    ? new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
    : Response.json({ error: {} }, { status: 404 })));
  const result = await loadArtifactPreview(ctx, 'artifact_1');
  expect(result.image?.type).toBe(mimeType);
  expect(new Uint8Array(await result.image!.arrayBuffer())).toEqual(bytes);
});

test('unknown binary artifacts remain download cards', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('/preview?')
    ? new Response('unknown file', { headers: { 'content-type': 'application/octet-stream' } })
    : Response.json({ error: {} }, { status: 404 })));
  expect(await loadArtifactPreview(ctx, 'artifact_1')).toEqual({ file: null, image: null });
});
