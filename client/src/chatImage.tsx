import { memo, useState } from 'react';
import { downloadImage } from './imageUtils';

const DownloadIcon = (
  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
  </svg>
);

/** 对话内图片预览：缩略图内联展示，点击放大（Lightbox），支持下载原图；加载失败回退为链接。 */
export const ChatImage = memo(function ChatImage({ src, alt }: { src: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  if (failed) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="break-all text-[#3550FF] underline decoration-[#3550FF]/30 hover:decoration-[#3550FF]">
        {alt || src}
      </a>
    );
  }

  return (
    <>
      <span className="group relative my-1 inline-block max-w-full align-top">
        <img
          src={src}
          alt={alt || '生成的图片'}
          loading="lazy"
          onError={() => setFailed(true)}
          onClick={() => setZoomed(true)}
          className="max-h-64 max-w-full cursor-zoom-in rounded-xl border border-black/10 bg-white object-contain"
        />
        <button
          type="button"
          title="下载原图"
          onClick={(event) => { event.stopPropagation(); void downloadImage(src); }}
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg bg-black/55 text-white opacity-0 transition hover:bg-black/75 group-hover:opacity-100"
        >
          {DownloadIcon}
        </button>
      </span>
      {zoomed && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setZoomed(false)}
        >
          <img
            src={src}
            alt={alt || '生成的图片'}
            className="max-h-[90vh] max-w-[92vw] cursor-zoom-out rounded-lg object-contain"
            onClick={(event) => { event.stopPropagation(); setZoomed(false); }}
          />
          <div className="absolute right-4 top-4 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              title="下载原图"
              onClick={() => void downloadImage(src)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/30"
            >
              {DownloadIcon}
            </button>
            <button
              type="button"
              title="关闭"
              onClick={() => setZoomed(false)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/30"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
});
