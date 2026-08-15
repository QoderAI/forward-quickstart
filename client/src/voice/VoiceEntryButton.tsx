import type { VoiceAvailability } from './useVoiceAvailability';
export function VoiceEntryButton({ availability, onStart }: { availability: VoiceAvailability; onStart: () => void }) {
  return <button type="button" aria-label="开始语音对话" title={availability.enabled ? '开始语音对话' : availability.reason} disabled={!availability.enabled} onClick={onStart} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-black/40 transition hover:bg-[#3550FF]/8 hover:text-[#3550FF] disabled:cursor-not-allowed disabled:opacity-30"><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></svg></button>;
}
