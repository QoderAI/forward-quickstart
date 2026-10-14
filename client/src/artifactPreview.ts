import { ForwardApiError, getCloudFile, previewCloudFile, type CloudFile, type ForwardContext } from './forwardApi';
import { isImageFile } from './imageUtils';

async function imageMimeType(blob: Blob): Promise<string | null> {
  if (isImageFile({ mime_type: blob.type })) return blob.type;
  if (blob.type && blob.type !== 'application/octet-stream') return null;
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const matches = (signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (matches([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (matches([255, 216, 255])) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  if (text(0, 2) === 'BM') return 'image/bmp';
  if (text(4, 8) === 'ftyp' && ['avif', 'avis'].includes(text(8, 12))) return 'image/avif';
  return null;
}

export async function loadArtifactPreview(ctx: ForwardContext, fileId: string): Promise<{ file: CloudFile | null; image: Blob | null }> {
  let file: CloudFile | null;
  try {
    file = await getCloudFile(ctx, fileId);
  } catch (error) {
    // Forward can authorize an artifact's /content while its metadata is absent.
    // The content endpoint still performs authorization; don't mask 401/403.
    if (!(error instanceof ForwardApiError) || error.status !== 404) throw error;
    file = null;
  }
  if (file && !isImageFile(file)) return { file, image: null };
  const image = await previewCloudFile(ctx, fileId);
  if (file) return { file, image };
  const mimeType = await imageMimeType(image);
  return { file, image: mimeType ? image.slice(0, image.size, mimeType) : null };
}
