import { useState } from 'react';
import type { ForwardContext } from '../forwardApi';
import { useVoiceSession, type VoiceStage } from './useVoiceSession';
import type { TimelineEntry, WorkEntry, WorkStep } from './voiceTimeline';

const stageCopy: Record<VoiceStage, string> = {
  idle: '准备中',
  'loading-history': '正在加载历史',
  connecting: '正在连接',
  listening: '我在听',
  thinking: '正在处理任务',
  speaking: '正在回答',
  reconnecting: '正在恢复连接',
  ending: '正在结束',
  ended: '语音已结束',
  error: '连接异常',
};

const workStatusCopy: Record<string, string> = {
  accepted: '已受理',
  queued: '排队中',
  running: '任务处理中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '执行失败',
};

const settledWorkStatuses = new Set(['completed', 'cancelled', 'failed']);
const activeVoiceStages = new Set<VoiceStage>(['listening', 'thinking', 'speaking', 'reconnecting']);

interface VoiceSessionViewProps {
  ctx: ForwardContext;
  identityId: string;
  templateId: string;
  templateName: string;
  initialConversationId: string | null;
  autoStart: boolean;
  launchKey: number;
  onConversationCreated: (id: string) => void;
  onStartFailed: (message: string) => void;
  onNewConversation: () => void;
  onEnded?: () => void;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
    </svg>
  );
}

function ToolStep({ step }: { step: WorkStep }) {
  const result = step.kind === 'tool_result';
  const tone = result ? 'bg-emerald-50 text-emerald-700' : 'bg-orange-50 text-orange-600';
  const payloadTone = result
    ? 'border-emerald-200 bg-emerald-50/60'
    : 'border-black/10 bg-[#FAFAFA]';

  return (
    <details className="group rounded-xl border border-black/[0.06] bg-white px-3 py-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs">
        <svg className="h-3.5 w-3.5 shrink-0 text-black/35" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="m14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-5.9 5.9a2.1 2.1 0 1 1-3-3l5.9-5.9a5 5 0 0 1 6.4-6.4l-3 3 3 3Z" />
        </svg>
        <span className={`rounded-md px-2 py-0.5 font-semibold ${tone}`}>{result ? '结果' : '调用'}</span>
        <span className="min-w-0 truncate font-mono text-black/50" title={step.title}>{step.title || '工具'}</span>
        <span className="ml-auto text-black/25 group-open:hidden">›</span>
        <span className="ml-auto hidden text-black/25 group-open:inline">⌄</span>
      </summary>
      <div className="mt-3">
        <div className="mb-2 font-medium text-black/35">{result ? '出参' : '入参'}</div>
        {step.detail ? (
          <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-[12px] leading-5 text-black/70 ${payloadTone}`}>
            {step.detail}
          </pre>
        ) : (
          <div className="text-black/30">暂无详情</div>
        )}
      </div>
    </details>
  );
}

function WorkStepRow({ step }: { step: WorkStep }) {
  if (step.kind === 'tool_use' || step.kind === 'tool_result') return <ToolStep step={step} />;

  const label = step.kind === 'thinking'
    ? '思考'
    : step.kind === 'milestone'
      ? '进展'
      : step.kind === 'message'
        ? '输出'
        : '进展';

  return (
    <div className={`flex gap-2 rounded-lg px-1 py-1 text-xs leading-5 ${step.isError ? 'text-red-600' : 'text-black/50'}`}>
      <span className="mt-0.5 shrink-0 rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] font-medium text-black/40">{label}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{step.detail || step.title || '处理中'}</span>
    </div>
  );
}

function WorkCard({ entry }: { entry: WorkEntry }) {
  const settled = settledWorkStatuses.has(entry.status) || Boolean(entry.result);
  const [detailsToggled, setDetailsToggled] = useState<boolean | null>(null);
  const detailsOpen = detailsToggled ?? !settled;
  const failed = entry.status === 'failed';
  const detailCount = entry.steps.length + (entry.result ? 1 : 0);
  const statusTone = failed
    ? 'bg-red-50 text-red-600'
    : settled
      ? 'bg-black/[0.04] text-black/45'
      : 'bg-[#EEF1FF] text-[#3550FF]';

  return (
    <section className={`rounded-xl border bg-[#FCFCFD] px-4 py-3 shadow-[0_8px_26px_rgba(47,58,128,0.04)] ${settled ? 'border-black/[0.07]' : 'border-[#3550FF]/20'}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-black/70" title={entry.objective}>{entry.objective}</span>
        <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusTone}`}>
          {!settled && <span className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" aria-label="任务执行中" />}
          {workStatusCopy[entry.status] || entry.status}
        </span>
      </div>
      {detailCount > 0 && (
        <div className="mt-2.5 border-t border-black/[0.06] pt-2.5">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsToggled(!detailsOpen)}
            className="flex items-center gap-1.5 text-xs font-semibold text-black/35 transition hover:text-black/55"
          >
            <ChevronIcon expanded={detailsOpen} />
            执行详情（{detailCount}）
          </button>
          {detailsOpen && (
            <div className="mt-2 space-y-2">
              {entry.steps.map((step, index) => <WorkStepRow key={`${step.kind}-${index}`} step={step} />)}
              {entry.result && (
                <div className="rounded-xl border border-black/[0.05] bg-white px-3 py-2.5 text-xs leading-5 text-black/65">
                  {entry.result}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'work') return <WorkCard entry={entry} />;

  return (
    <div className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-6 ${entry.role === 'user' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F4F5] text-black/75'}`}>
        {entry.text}
        {entry.pending && <span className="ml-1 animate-pulse">…</span>}
      </div>
    </div>
  );
}

function MicrophoneIcon({ muted }: { muted: boolean }) {
  return muted ? (
    <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="m4 4 16 16M9.5 5.3A3.5 3.5 0 0 1 15.5 7.8v3.4c0 .5-.1 1-.3 1.4M18.5 11.5a6.5 6.5 0 0 1-1.1 3.6M13.5 18.8V22m-3 0h6M5.5 11.5a6.5 6.5 0 0 0 9.9 5.5M8.5 10.5V7.8" />
    </svg>
  ) : (
    <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6" />
    </svg>
  );
}

function CallControls({
  stage,
  muted,
  onMutedChange,
  onEnd,
}: {
  stage: VoiceStage;
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  onEnd: () => void;
}) {
  if (!activeVoiceStages.has(stage)) return null;

  return (
    <>
      <button
        type="button"
        aria-label={muted ? '取消静音' : '静音'}
        title={muted ? '取消静音' : '静音'}
        onClick={() => onMutedChange(!muted)}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition ${muted ? 'border-orange-300 bg-orange-50 text-orange-600' : 'border-black/15 bg-white text-black/65 hover:border-[#3550FF] hover:text-[#3550FF]'}`}
      >
        <MicrophoneIcon muted={muted} />
      </button>
      <button
        type="button"
        aria-label="结束语音"
        title="结束语音"
        onClick={onEnd}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FF5A64] text-white shadow-[0_5px_14px_rgba(255,90,100,0.24)] transition hover:bg-[#F24955]"
      >
        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
        </svg>
      </button>
    </>
  );
}

export function VoiceSessionView(props: VoiceSessionViewProps) {
  const voice = useVoiceSession(props);
  const [text, setText] = useState('');
  const disabled = !['listening', 'thinking', 'speaking'].includes(voice.stage);

  const send = () => {
    if (voice.sendText(text)) setText('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex items-center justify-between border-b border-black/5 px-7 py-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="h-2 w-2 rounded-full bg-[#3550FF]" />
          <b>{stageCopy[voice.stage]}</b>
          <span className="text-black/35">· {props.templateName}</span>
        </div>
        <div className="flex items-center gap-3">
          <code className="text-xs text-black/35">{voice.conversationId || 'creating...'}</code>
          <button type="button" onClick={props.onNewConversation} className="rounded-lg border border-black/10 px-3 py-1.5 text-xs text-black/55 transition hover:border-[#3550FF]/50 hover:text-[#3550FF]">新建对话</button>
        </div>
      </div>

      {(voice.error || voice.microphoneWarning || voice.stage === 'reconnecting') && (
        <div className="mx-7 mt-3 rounded-xl bg-amber-50 px-4 py-2 text-xs text-amber-700">
          {voice.error || voice.microphoneWarning || '正在恢复连接，期间语音不会被处理'}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-[860px] space-y-4">
          {voice.timeline.length === 0 && <div className="py-24 text-center text-sm text-black/30">直接说话，或在下方输入问题</div>}
          {voice.timeline.map((entry) => <TimelineItem key={entry.id} entry={entry} />)}
        </div>
      </div>

      <div className="border-t border-black/[0.06] bg-white px-7 py-4">
        <div className="mx-auto max-w-[860px]">
          <div className="mb-3 flex justify-center gap-2">
            {['介绍一下你能做什么', '帮我看看有哪些文件'].map((item) => (
              <button
                type="button"
                key={item}
                disabled={disabled || voice.stage === 'thinking'}
                onClick={() => voice.sendText(item)}
                className="rounded-full border border-black/15 px-3 py-1.5 text-xs text-black/55 transition hover:border-[#3550FF]/50 hover:text-[#3550FF] disabled:opacity-30"
              >
                “{item}”
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <CallControls
              stage={voice.stage}
              muted={voice.muted}
              onMutedChange={voice.setMuted}
              onEnd={() => void voice.end().then(() => props.onEnded?.())}
            />
            {voice.stage === 'ended' ? (
              <button type="button" onClick={() => void voice.continueConversation()} className="h-10 flex-1 rounded-xl bg-[#3550FF] text-sm text-white">继续语音对话</button>
            ) : (
              <>
                <input
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };
                    if (event.key === 'Enter' && !nativeEvent.isComposing && nativeEvent.keyCode !== 229) send();
                  }}
                  disabled={disabled}
                  placeholder="也可以打字说……"
                  className="h-10 min-w-0 flex-1 rounded-xl border border-black/15 px-4 text-sm outline-none transition focus:border-[#3550FF] disabled:bg-black/[0.02]"
                />
                <button
                  type="button"
                  aria-label="发送"
                  onClick={send}
                  disabled={disabled || !text.trim()}
                  className="flex h-10 w-11 shrink-0 items-center justify-center rounded-xl bg-[#3550FF] text-white transition hover:bg-[#2942E8] disabled:opacity-30"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m12 19 0-14m0 0-6 6m6-6 6 6" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
