import type React from 'react';

/** 通用弹窗组件：白底圆角、半透明遮罩，内容超高时内部滚动。 */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-[520px] max-h-[90vh] overflow-y-auto rounded-2xl bg-white px-5 py-4 shadow-[0_8px_40px_rgba(0,0,0,0.12)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-black">{title}</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-black/30 transition hover:bg-black/5 hover:text-black/60">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
