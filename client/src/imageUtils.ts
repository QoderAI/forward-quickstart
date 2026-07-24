const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#].*)?$/i;

export function isImageUrl(url: string): boolean {
  return /^https?:\/\/\S+/i.test(url) && IMAGE_EXT_RE.test(url);
}

export function imageFilename(url: string): string {
  try {
    const { pathname } = new URL(url);
    const name = pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : 'image';
  } catch {
    return 'image';
  }
}

// 跨域图片直接 <a download> 会被浏览器忽略，先尝试 fetch 成 Blob 再保存；
// 失败（如 CORS）时退化为新标签页打开原图。
export async function downloadImage(url: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = imageFilename(url);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
