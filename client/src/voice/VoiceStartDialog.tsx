import { useEffect, useId, useRef, useState } from 'react';
import { REALTIME_VOICES, realtimeVoiceName, type RealtimeVoice } from './voiceApi';

interface VoiceStartDialogProps {
  initialVoice: RealtimeVoice;
  onCancel: () => void;
  onConfirm: (voice: RealtimeVoice) => void | Promise<void>;
}

export function VoiceStartDialog({ initialVoice, onCancel, onConfirm }: VoiceStartDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const groupName = useId();
  const [selected, setSelected] = useState(initialVoice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('input:checked')?.focus();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const confirm = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await onConfirm(selected);
    } catch {
      setError('暂时无法开始语音对话，请重试');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); if (!submitting.current) onCancel(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[420px] overflow-y-auto rounded-3xl border border-black/5 bg-white p-0 text-black shadow-2xl backdrop:bg-black/25 backdrop:backdrop-blur-sm">
      <form onSubmit={(event) => { event.preventDefault(); void confirm(); }} className="p-6 sm:p-7">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">选择对话音色</h2>
            <p id={descriptionId} className="mt-2 text-sm leading-6 text-black/45">
              选一个音色，开始和 Agent 聊聊。
            </p>
          </div>
          <button type="button" aria-label="关闭音色选择" disabled={busy} onClick={onCancel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-black/40 hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-[#3550FF] disabled:opacity-30">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <fieldset disabled={busy} className="space-y-2">
          <legend className="sr-only">对话音色</legend>
          {REALTIME_VOICES.map((voice, index) => (
            <label key={voice.id} className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition focus-within:ring-2 focus-within:ring-[#3550FF]/40 ${selected === voice.id ? 'border-[#3550FF] bg-[#3550FF]/5' : 'border-black/10 hover:border-[#3550FF]/40 hover:bg-black/[0.015]'} ${busy ? 'pointer-events-none opacity-50' : ''}`}>
              <input type="radio" name={groupName} value={voice.id} checked={selected === voice.id}
                onChange={() => setSelected(voice.id)} className="sr-only" />
              <span aria-hidden="true" className={`flex h-9 w-9 items-center justify-center rounded-full ${selected === voice.id ? 'bg-[#3550FF]/10 text-[#3550FF]' : 'bg-black/5 text-black/35'}`}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
                </svg>
              </span>
              <span className="flex-1 text-sm font-medium">{voice.name}</span>
              {index === 0 && <span className="text-xs text-black/35">默认音色</span>}
              <span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-full border ${selected === voice.id ? 'border-[#3550FF] bg-[#3550FF] text-white' : 'border-black/15'}`}>
                {selected === voice.id && <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m3 8 3 3 7-7" /></svg>}
              </span>
            </label>
          ))}
        </fieldset>
        <p className="mt-4 text-xs leading-5 text-black/40">音色在本次对话中保持不变，之后可新建对话更换。</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy}
          className="mt-5 w-full rounded-xl bg-[#3550FF] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#2942E8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3550FF] disabled:cursor-wait disabled:opacity-50">
          {busy ? '正在准备新对话…' : `用${realtimeVoiceName(selected)}音色开始`}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="mt-2 w-full rounded-xl py-2 text-sm text-black/45 hover:bg-black/5 disabled:opacity-30">取消</button>
      </form>
    </dialog>
  );
}
