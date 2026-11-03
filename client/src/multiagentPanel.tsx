import { useState } from 'react';
import type { MultiagentConfig } from './forwardApi';
import type { MultiagentThread, MultiagentThreadStatus } from './multiagent';

// ─── Multi Agent 协同的对话界面可视化 ───
// 协调者会话专用：团队状态条 + 派发/回执卡片 + 子线程状态行。
// 非协调者模板不会渲染这里的任何组件，对话保持原有单 Agent 形态。

const STATUS_META: Record<MultiagentThreadStatus, { label: string; dot: string; chip: string }> = {
  created: { label: '加入协同', dot: 'bg-[#3550FF]', chip: 'bg-[#3550FF]/10 text-[#3550FF]' },
  running: { label: '执行中', dot: 'bg-[#3550FF] animate-pulse', chip: 'bg-[#3550FF]/10 text-[#3550FF]' },
  idle: { label: '已完成', dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-600' },
  rescheduled: { label: '排队重试', dot: 'bg-amber-500 animate-pulse', chip: 'bg-amber-50 text-amber-600' },
  unknown: { label: '待命', dot: 'bg-black/20', chip: 'bg-gray-100 text-black/40' },
};

function formatTime(at?: string): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function CollapsibleText({ text, previewChars = 260 }: { text: string; previewChars?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > previewChars;
  const shown = open || !long ? text : `${text.slice(0, previewChars)}…`;
  return (
    <div>
      <div className="max-h-[320px] whitespace-pre-wrap break-words overflow-y-auto text-[13px] leading-6 text-black/70">
        {shown}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-1 text-[11px] text-[#3550FF] hover:underline"
        >
          {open ? '收起' : `展开全文（共 ${text.length} 字）`}
        </button>
      )}
    </div>
  );
}

function AgentBadge({ name, tone }: { name: string; tone: 'dispatch' | 'reply' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
        tone === 'dispatch' ? 'bg-[#3550FF]/10 text-[#3550FF]' : 'bg-emerald-50 text-emerald-600'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone === 'dispatch' ? 'bg-[#3550FF]' : 'bg-emerald-500'}`} />
      {name}
    </span>
  );
}

/** 协调者 → 子 Agent 的任务派发卡片。 */
export function MultiagentDispatchCard({ name, text, at }: { name: string; text: string; at?: string }) {
  return (
    <div className="flex justify-center">
      <div className="w-full rounded-xl border border-[#E5E7EB] border-l-[3px] border-l-[#3550FF] bg-[#FAFBFF] px-4 py-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-black/40">协调者 →</span>
          <AgentBadge name={name} tone="dispatch" />
          <span className="rounded border border-[#3550FF]/30 px-1 py-px text-[10px] text-[#3550FF]">派发任务</span>
          {formatTime(at) && <span className="ml-auto text-[10px] tabular-nums text-black/30">{formatTime(at)}</span>}
        </div>
        <CollapsibleText text={text} />
      </div>
    </div>
  );
}

/** 子 Agent → 协调者的回执卡片。 */
export function MultiagentReplyCard({ name, text, at }: { name: string; text: string; at?: string }) {
  return (
    <div className="flex justify-center">
      <div className="w-full rounded-xl border border-[#E5E7EB] border-l-[3px] border-l-emerald-500 bg-white px-4 py-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <AgentBadge name={name} tone="reply" />
          <span className="text-[11px] text-black/40">→ 协调者</span>
          <span className="rounded border border-emerald-200 px-1 py-px text-[10px] text-emerald-600">回复</span>
          {formatTime(at) && <span className="ml-auto text-[10px] tabular-nums text-black/30">{formatTime(at)}</span>}
        </div>
        <CollapsibleText text={text} />
      </div>
    </div>
  );
}

/** 子线程生命周期状态行（创建 / 运行 / 完成 / 重试）。 */
export function MultiagentStatusLine({
  name,
  status,
  stopReason,
}: {
  name: string;
  status: MultiagentThreadStatus;
  stopReason?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <div className="flex items-center justify-center gap-1.5 py-0.5">
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      <span className="text-[11px] text-black/40">
        {name} · {meta.label}
        {status === 'idle' && stopReason ? `（${stopReason}）` : ''}
      </span>
    </div>
  );
}

function matchThread(threads: MultiagentThread[], rosterName: string): MultiagentThread | undefined {
  if (!rosterName) return undefined;
  return threads.find((t) => t.name === rosterName || t.name.includes(rosterName) || rosterName.includes(t.name));
}

/** 对话区顶部的协同团队状态条：协调者 + 花名册 + 每个子 Agent 的实时状态。 */
export function MultiagentTeamPanel({
  config,
  coordinatorName,
  threads,
}: {
  config: MultiagentConfig;
  coordinatorName: string;
  threads: MultiagentThread[];
}) {
  const subThreads = threads.filter((t) => !t.isCoordinator);
  const matched = new Set<string>();
  const roster = config.agents.map((entry) => {
    const name = entry.name || entry.template_id || '子 Agent';
    const thread = matchThread(subThreads, name);
    if (thread) matched.add(thread.id);
    return { name, thread };
  });
  const extra = subThreads.filter((t) => !matched.has(t.id));
  const running = subThreads.filter((t) => t.status === 'running' || t.status === 'rescheduled').length;

  return (
    <div className="shrink-0 px-8 pt-4">
      <div className="mx-auto max-w-[860px] rounded-xl border border-[#DDE2F2] bg-[#FAFBFF] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-[#3550FF] px-1.5 py-0.5 text-[11px] font-medium text-white">多 Agent 协同</span>
          <span className="text-[13px] font-medium text-black/75">{coordinatorName}</span>
          <span className="text-[11px] text-black/40">（协调者）</span>
          <span className="ml-auto text-[11px] text-black/40">
            {subThreads.length > 0
              ? `${subThreads.length} 个子 Agent 参与 · ${running} 个执行中`
              : `花名册 ${config.agents.length} 个子 Agent · 发送消息后开始协同`}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {roster.map(({ name, thread }) => {
            const meta = STATUS_META[thread?.status ?? 'unknown'];
            return (
              <span
                key={name}
                title={thread ? `派发 ${thread.dispatches.length} 次 · 回复 ${thread.replies.length} 次` : '尚未被派发'}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${meta.chip}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                {name}
                <span className="text-black/35">
                  {thread ? `${meta.label} · 派发${thread.dispatches.length}/回复${thread.replies.length}` : '待命'}
                </span>
              </span>
            );
          })}
          {extra.map((thread) => {
            const meta = STATUS_META[thread.status];
            return (
              <span
                key={thread.id}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${meta.chip}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                {thread.name}
                <span className="text-black/35">{meta.label}</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
