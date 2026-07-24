import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BATCH_TERMINAL_STATUSES,
  cancelBatch,
  createBatch,
  downloadCloudFile,
  getBatch,
  getBatchOutput,
  listBatches,
  uploadCloudFile,
  type BatchCompletionWindow,
  type BatchInputLine,
  type BatchStatus,
  type ForwardBatch,
  type ForwardContext,
  type ForwardTemplate,
} from './forwardApi';
import { Modal } from './modal';

// ─── 状态视觉映射（10 种状态 → 5 类视觉，文案以中文为主，见设计文档 1.3） ───

const BATCH_STATUS_META: Record<BatchStatus, { label: string; cls: string; spin?: boolean }> = {
  validating: { label: '校验中', cls: 'bg-gray-100 text-black/40', spin: true },
  queued: { label: '等待调度', cls: 'bg-gray-100 text-black/40' },
  processing: { label: '执行中', cls: 'bg-blue-50 text-[#3550FF]', spin: true },
  finalizing: { label: '生成结果中', cls: 'bg-blue-50 text-[#3550FF]', spin: true },
  cancelling: { label: '取消中', cls: 'bg-amber-50 text-amber-600', spin: true },
  expiring: { label: '过期中', cls: 'bg-amber-50 text-amber-600', spin: true },
  completed: { label: '已完成', cls: 'bg-emerald-50 text-emerald-600' },
  failed: { label: '失败', cls: 'bg-red-50 text-red-500' },
  cancelled: { label: '已取消', cls: 'bg-gray-100 text-black/40' },
  expired: { label: '已过期', cls: 'bg-gray-100 text-black/40' },
};

const COMPLETION_WINDOWS: BatchCompletionWindow[] = ['24h', '48h', '72h'];

// 状态时间线主路径（详情弹窗用）
const TIMELINE_STEPS: Array<{ status: BatchStatus; label: string }> = [
  { status: 'validating', label: '校验输入文件' },
  { status: 'queued', label: '等待闲时调度' },
  { status: 'processing', label: '执行任务' },
  { status: 'finalizing', label: '生成输出文件' },
  { status: 'completed', label: '完成' },
];

function isTerminal(status: BatchStatus) {
  return BATCH_TERMINAL_STATUSES.has(status);
}

function displayTime(iso: string | undefined) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: BatchStatus }) {
  const meta = BATCH_STATUS_META[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>
      {meta.spin && <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-60" />}
      {meta.label}
    </span>
  );
}

/** 分段进度条：completed(绿)/failed(红)/cancelled+expired(灰)/running(蓝·动画)/pending(浅灰底)。 */
function BatchProgressBar({ batch, tall }: { batch: ForwardBatch; tall?: boolean }) {
  const c = batch.request_counts;
  if (!c || c.total === 0) {
    return <div className={`w-full rounded-full bg-gray-100 text-center text-[10px] leading-4 text-black/30 ${tall ? 'h-4' : 'h-2'}`}>{tall ? '校验中' : ''}</div>;
  }
  const pct = (n: number) => `${(n / c.total) * 100}%`;
  const terminated = c.cancelled + c.expired;
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-gray-100 ${tall ? 'h-3' : 'h-2'}`}>
      {c.completed > 0 && <div className="bg-emerald-400" style={{ width: pct(c.completed) }} />}
      {c.failed > 0 && <div className="bg-red-400" style={{ width: pct(c.failed) }} />}
      {terminated > 0 && <div className="bg-gray-300" style={{ width: pct(terminated) }} />}
      {c.running > 0 && <div className="animate-pulse bg-[#3550FF]/70" style={{ width: pct(c.running) }} />}
    </div>
  );
}

// ─── JSONL 前端预校验（呼应 CreateBatch 校验规则） ───

interface JsonlValidation {
  okLines: BatchInputLine[];
  errors: Array<{ line: number; reason: string }>;
  autoFilledIdentity: number; // 自动补全 identity_id 的行数
}

function validateJsonl(text: string, currentIdentityId: string): JsonlValidation {
  const okLines: BatchInputLine[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  const seenIds = new Set<string>();
  let autoFilledIdentity = 0;
  const rawLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length > 10000) {
    errors.push({ line: 0, reason: `共 ${rawLines.length} 行，超过单批次 10,000 行上限` });
    return { okLines, errors, autoFilledIdentity };
  }
  rawLines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      errors.push({ line: lineNo, reason: 'JSON 解析失败' });
      return;
    }
    const customId = typeof obj.custom_id === 'string' ? obj.custom_id : '';
    const templateId = typeof obj.template_id === 'string' ? obj.template_id : '';
    let identityId = typeof obj.identity_id === 'string' ? obj.identity_id : '';
    const body = obj.body && typeof obj.body === 'object' ? obj.body as Record<string, unknown> : null;
    // 缺失 identity_id 时自动补全为当前登录 Identity（降低 ID 门槛，见设计文档 2.2）
    if (!identityId && currentIdentityId) {
      identityId = currentIdentityId;
      autoFilledIdentity += 1;
    }
    const missing: string[] = [];
    if (!customId) missing.push('custom_id');
    if (!templateId) missing.push('template_id');
    if (!identityId) missing.push('identity_id');
    if (!body) missing.push('body');
    if (missing.length > 0) {
      errors.push({ line: lineNo, reason: `缺少必填字段 ${missing.join('、')}` });
      return;
    }
    if (seenIds.has(customId)) {
      errors.push({ line: lineNo, reason: `custom_id "${customId}" 重复` });
      return;
    }
    seenIds.add(customId);
    okLines.push({ custom_id: customId, template_id: templateId, identity_id: identityId, body: body! });
  });
  return { okLines, errors, autoFilledIdentity };
}

function linesToJsonl(lines: BatchInputLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

function triggerDownload(url: string, filename?: string) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ─── 批量任务面板 ───

export function BatchPanel({ ctx, identityId, templates, defaultTemplateId }: {
  ctx: ForwardContext | null;
  identityId: string;
  templates: ForwardTemplate[];
  defaultTemplateId?: string;
}) {
  const [batches, setBatches] = useState<ForwardBatch[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'in_progress' | BatchStatus>('all');
  const [detailBatch, setDetailBatch] = useState<ForwardBatch | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ForwardBatch | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [showWizard, setShowWizard] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const loadBatches = useCallback(async (opts?: { append?: boolean; afterId?: string }) => {
    if (!ctx) return;
    setListLoading(true);
    setListError('');
    try {
      const singleStatus = statusFilter !== 'all' && statusFilter !== 'in_progress' ? statusFilter : undefined;
      const page = await listBatches(ctx, { status: singleStatus, afterId: opts?.afterId });
      let data = page.data ?? [];
      // 「进行中」为前端聚合筛选（API 的 status 参数单值）
      if (statusFilter === 'in_progress') data = data.filter((b) => !isTerminal(b.status));
      setBatches((prev) => (opts?.append ? [...prev, ...data] : data));
      setHasMore(!!page.has_more);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setListLoading(false);
    }
  }, [ctx, statusFilter]);

  // 进入面板 / 切换筛选时自动刷新一次列表
  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  // 详情弹窗打开时：非终态自动轮询（5s 起步 ×1.5 退避至 30s，终态停止）
  useEffect(() => {
    stopPolling();
    if (!ctx || !detailBatch || isTerminal(detailBatch.status)) return;
    let cancelled = false;
    let interval = 5000;
    const poll = async () => {
      try {
        const fresh = await getBatch(ctx, detailBatch.id);
        if (cancelled) return;
        setDetailBatch((prev) => (prev && prev.id === fresh.id ? fresh : prev));
        setBatches((prev) => prev.map((b) => (b.id === fresh.id ? fresh : b)));
        if (!isTerminal(fresh.status)) {
          interval = Math.min(interval * 1.5, 30000);
          pollTimerRef.current = window.setTimeout(() => void poll(), interval);
        }
      } catch { /* 轮询失败静默，用户可手动刷新 */ }
    };
    pollTimerRef.current = window.setTimeout(() => void poll(), interval);
    return () => { cancelled = true; stopPolling(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, detailBatch?.id, detailBatch?.status, stopPolling]);

  const handleCancel = useCallback(async () => {
    if (!ctx || !cancelTarget) return;
    setCancelling(true);
    try {
      const updated = await cancelBatch(ctx, cancelTarget.id);
      setBatches((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      setDetailBatch((prev) => (prev && prev.id === updated.id ? updated : prev));
      setCancelTarget(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }, [ctx, cancelTarget]);

  const handleDownloadOutput = useCallback(async (batch: ForwardBatch) => {
    if (!ctx) return;
    setDownloadError('');
    try {
      const { url } = await getBatchOutput(ctx, batch.id);
      if (!url) throw new Error('未获取到下载链接');
      triggerDownload(url, `batch-${batch.id}-output.jsonl`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('file_expired') || msg.includes('410')) {
        setDownloadError('输出文件已超过 30 天保留期，无法下载');
      } else if (msg.includes('batch_not_ready')) {
        setDownloadError('任务完成后可下载');
      } else {
        setDownloadError(`下载失败：${msg}`);
      }
    }
  }, [ctx]);

  const handleDownloadError = useCallback(async (batch: ForwardBatch) => {
    if (!ctx || !batch.error_file_id) return;
    setDownloadError('');
    try {
      // error.jsonl 无专用端点，经 error_file_id 走 Cloud Files 下载链路
      const { url } = await downloadCloudFile(ctx, batch.error_file_id);
      if (!url) throw new Error('未获取到下载链接');
      triggerDownload(url, `batch-${batch.id}-error.jsonl`);
    } catch (err) {
      setDownloadError(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [ctx]);

  return (
    <div className="h-full overflow-y-auto bg-[#FAFBFF]">
      <div className="flex max-w-[1440px] flex-col gap-4 p-6">
        <div className="flex flex-col gap-4 px-1">
          <h1 className="text-xl font-semibold text-black">批量任务</h1>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-black/60">基于 JSONL 输入文件批量执行 Agent 任务，平台闲时时段自动调度</span>
              <button onClick={() => void loadBatches()} className="flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-white hover:shadow-sm" title="刷新">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.58m15.36 2A8 8 0 0 0 4.58 9m0 0H9m11 11v-5h-.58m0 0A8 8 0 0 1 4.06 13m15.36 2H15" /></svg>
              </button>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                className="h-8 rounded-lg border border-[#E5E7EB] bg-white px-2 text-xs text-black/60 outline-none transition focus:border-[#3550FF]"
              >
                <option value="all">全部状态</option>
                <option value="in_progress">进行中</option>
                <option value="completed">已完成</option>
                <option value="failed">失败</option>
                <option value="cancelled">已取消</option>
                <option value="expired">已过期</option>
              </select>
              <button
                onClick={() => setShowWizard(true)}
                disabled={!ctx || templates.length === 0}
                className="rounded-full bg-[#3550FF] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
              >
                + 创建批量任务
              </button>
            </div>
          </div>
        </div>

        {listError && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-500">{listError}</div>}

        {/* 列表 */}
        <div className="space-y-3">
          {batches.map((batch) => {
            const c = batch.request_counts;
            return (
              <div key={batch.id} className="rounded-2xl border border-[#DDE2F2] bg-white p-5 transition hover:shadow-md">
                <div className="flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { setDownloadError(''); setDetailBatch(batch); }}
                        className="truncate font-mono text-[13px] font-medium text-black/75 hover:text-[#3550FF]"
                        title="查看详情"
                      >
                        {batch.id}
                      </button>
                      <StatusBadge status={batch.status} />
                    </div>
                    <div className="mt-2.5 flex items-center gap-3">
                      <div className="w-full max-w-[280px]"><BatchProgressBar batch={batch} /></div>
                      <span className="shrink-0 text-xs text-black/40">{c ? `${c.completed}/${c.total}` : '—'}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-black/40">
                      <span>窗口 {batch.completion_window}</span>
                      <span>创建 {displayTime(batch.created_at)}</span>
                      <span>执行截止 {displayTime(batch.expires_at)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => { setDownloadError(''); setDetailBatch(batch); }}
                      className="rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-black/60 transition hover:bg-gray-50"
                    >
                      详情
                    </button>
                    {!isTerminal(batch.status) && (
                      <button
                        onClick={() => setCancelTarget(batch)}
                        className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-500 transition hover:bg-red-50"
                      >
                        取消
                      </button>
                    )}
                    {batch.output_file_id && (
                      <button
                        onClick={() => void handleDownloadOutput(batch)}
                        className="rounded-lg bg-[#3550FF] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#2a42e0]"
                      >
                        ⬇ 下载
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {batches.length === 0 && !listLoading && (
            <div className="rounded-2xl bg-white px-5 py-12 text-center shadow-[inset_0_0_0_1px_#2F3A801A]">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F4F6FC] text-2xl">▤</div>
              <div className="text-sm font-medium text-black/60">暂无批量任务</div>
              <div className="mt-1 text-xs text-black/35">上传 JSONL 文件批量执行 Agent 任务，平台将在闲时时段自动调度执行</div>
              <button
                onClick={() => setShowWizard(true)}
                disabled={!ctx || templates.length === 0}
                className="mt-4 rounded-full bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
              >
                + 创建第一个批量任务
              </button>
            </div>
          )}
          {listLoading && batches.length === 0 && (
            <div className="flex justify-center py-10">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-[#D7DBEA] border-t-[#3550FF]" />
            </div>
          )}
          {hasMore && batches.length > 0 && (
            <div className="flex justify-center">
              <button
                onClick={() => void loadBatches({ append: true, afterId: batches[batches.length - 1]?.id })}
                disabled={listLoading}
                className="rounded-full border border-[#DDE2F2] bg-white px-4 py-2 text-xs text-black/60 transition hover:border-[#3550FF] hover:text-[#3550FF] disabled:opacity-50"
              >
                {listLoading ? '加载中...' : '加载更多'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 详情弹窗 */}
      <Modal open={!!detailBatch} onClose={() => setDetailBatch(null)} title="Batch 详情">
        {detailBatch && (() => {
          const b = detailBatch;
          const c = b.request_counts;
          const isBranch = ['cancelling', 'cancelled', 'expiring', 'expired', 'failed'].includes(b.status);
          // 主路径高亮位置：分支状态下按已达到的最远主路径节点置灰后续
          const mainIdx = TIMELINE_STEPS.findIndex((s) => s.status === b.status);
          const reachedIdx = isBranch
            ? (c && c.total > 0 ? (b.status === 'failed' ? 0 : 2) : 0)
            : mainIdx;
          return (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 rounded-lg bg-[#F8F9FF] px-3 py-2">
                <button
                  onClick={() => void navigator.clipboard?.writeText(b.id).catch(() => {})}
                  className="truncate font-mono text-xs text-black/60 hover:text-[#3550FF]"
                  title="点击复制"
                >
                  {b.id} ⧉
                </button>
                <div className="flex items-center gap-2">
                  <StatusBadge status={b.status} />
                  {!isTerminal(b.status) && (
                    <button
                      onClick={() => setCancelTarget(b)}
                      className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[11px] font-medium text-red-500 transition hover:bg-red-50"
                    >
                      取消任务
                    </button>
                  )}
                </div>
              </div>

              {/* 状态时间线 */}
              <div>
                <div className="mb-2 text-[11px] font-medium text-black/40">执行进度</div>
                <div className="space-y-1.5">
                  {TIMELINE_STEPS.map((step, i) => {
                    const done = !isBranch && mainIdx > i;
                    const current = !isBranch && mainIdx === i;
                    const grey = isBranch ? i > reachedIdx : mainIdx < i;
                    return (
                      <div key={step.status} className={`flex items-center gap-2 text-xs ${grey && !current ? 'text-black/25' : current ? 'font-medium text-[#3550FF]' : 'text-black/60'}`}>
                        <span className="w-4 text-center">{done || (isBranch && i <= reachedIdx) ? '✔' : current ? '▶' : '○'}</span>
                        <span className="font-mono text-[11px]">{step.status}</span>
                        <span>{step.label}</span>
                      </div>
                    );
                  })}
                  {isBranch && (
                    <div className="flex items-center gap-2 text-xs font-medium text-black/60">
                      <span className="w-4 text-center">✖</span>
                      <span className="font-mono text-[11px]">{b.status}</span>
                      <span>{BATCH_STATUS_META[b.status].label}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* 任务计数 */}
              {c && (
                <div>
                  <div className="mb-2 text-[11px] font-medium text-black/40">任务计数</div>
                  <div className="mb-2 flex items-center gap-3">
                    <div className="flex-1"><BatchProgressBar batch={b} tall /></div>
                    <span className="shrink-0 text-xs text-black/50">{c.completed}/{c.total}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="rounded-lg bg-emerald-50 px-2 py-1.5 text-emerald-600">完成 {c.completed}</div>
                    <div className="rounded-lg bg-blue-50 px-2 py-1.5 text-[#3550FF]">运行中 {c.running}</div>
                    <div className="rounded-lg bg-gray-50 px-2 py-1.5 text-black/50">等待 {c.pending}</div>
                    <div className="rounded-lg bg-red-50 px-2 py-1.5 text-red-500">失败 {c.failed}</div>
                    <div className="rounded-lg bg-gray-50 px-2 py-1.5 text-black/50">取消 {c.cancelled}</div>
                    <div className="rounded-lg bg-gray-50 px-2 py-1.5 text-black/50">过期 {c.expired}</div>
                  </div>
                </div>
              )}

              {/* 基础信息 */}
              <div>
                <div className="mb-2 text-[11px] font-medium text-black/40">基础信息</div>
                <div className="space-y-1 text-xs text-black/60">
                  <div className="flex justify-between"><span className="text-black/40">完成窗口</span><span>{b.completion_window}</span></div>
                  <div className="flex justify-between"><span className="text-black/40">创建时间</span><span>{displayTime(b.created_at)}</span></div>
                  <div className="flex justify-between"><span className="text-black/40">执行截止</span><span>{displayTime(b.expires_at)}</span></div>
                  {b.metadata && Object.keys(b.metadata).length > 0 && (
                    <div className="mt-1.5">
                      <div className="mb-1 text-black/40">自定义标签</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(b.metadata).map(([k, v]) => (
                          <span key={k} className="rounded-md bg-[#F4F6FC] px-2 py-0.5 text-[11px] text-black/55">{k}：{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {/* 技术详情：内部 ID 收进可展开区，供排障（不默认透出，见设计文档 1.3） */}
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-black/35">▸ 技术详情（文件 ID / 原始状态）</summary>
                  <div className="mt-1 space-y-0.5 font-mono text-[11px] text-black/45">
                    <div>status: {b.status}</div>
                    <div>input_file_id: {b.input_file_id}</div>
                    {b.output_file_id && <div>output_file_id: {b.output_file_id}</div>}
                    {b.error_file_id && <div>error_file_id: {b.error_file_id}</div>}
                  </div>
                </details>
              </div>

              {/* 错误信息 */}
              {b.status === 'failed' && b.error_message && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">{b.error_message}</div>
              )}

              {/* 下载区：按文件 ID 存在与否显示，不按状态硬编码 */}
              {(b.output_file_id || b.error_file_id) && (
                <div>
                  <div className="mb-2 text-[11px] font-medium text-black/40">结果文件</div>
                  <div className="flex flex-wrap items-center gap-2">
                    {b.output_file_id && (
                      <button
                        onClick={() => void handleDownloadOutput(b)}
                        className="rounded-lg bg-[#3550FF] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#2a42e0]"
                      >
                        ⬇ 下载 output.jsonl
                      </button>
                    )}
                    {b.error_file_id && (
                      <button
                        onClick={() => void handleDownloadError(b)}
                        className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-500 transition hover:bg-red-50"
                      >
                        ⬇ 下载 error.jsonl{c && c.failed > 0 ? ` (${c.failed})` : ''}
                      </button>
                    )}
                  </div>
                  <div className="mt-1.5 text-[11px] text-black/35">结果文件保留 30 天，请及时下载</div>
                </div>
              )}
              {downloadError && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{downloadError}</div>}
            </div>
          );
        })()}
      </Modal>

      {/* 取消确认弹窗 */}
      <Modal open={!!cancelTarget} onClose={() => setCancelTarget(null)} title="取消批量任务">
        {cancelTarget && (
          <div className="space-y-3">
            <div className="text-sm text-black/70">确定取消 <span className="font-mono text-xs">{cancelTarget.id}</span> 吗？</div>
            <ul className="space-y-1 rounded-lg bg-[#F8F9FF] px-3 py-2 text-xs leading-5 text-black/55">
              <li>· 等待中的任务将立即终止</li>
              <li>· 正在运行的任务会被取消，需要一段时间</li>
              {cancelTarget.request_counts && cancelTarget.request_counts.completed > 0 && (
                <li>· 已完成的 {cancelTarget.request_counts.completed} 个任务结果仍可下载</li>
              )}
              <li>· 此操作不可撤销</li>
            </ul>
            <div className="flex justify-end gap-2">
              <button onClick={() => setCancelTarget(null)} className="rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-xs font-medium text-black/60 transition hover:bg-gray-50">再想想</button>
              <button
                onClick={() => void handleCancel()}
                disabled={cancelling}
                className="rounded-lg bg-red-500 px-4 py-2 text-xs font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
              >
                {cancelling ? '取消中...' : '确认取消'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* 创建向导 */}
      {showWizard && (
        <BatchCreateWizard
          ctx={ctx}
          identityId={identityId}
          templates={templates}
          defaultTemplateId={defaultTemplateId}
          onClose={() => setShowWizard(false)}
          onCreated={(batch) => {
            setShowWizard(false);
            setBatches((prev) => [batch, ...prev]);
          }}
        />
      )}
    </div>
  );
}

// ─── 创建向导（3 步） ───

function BatchCreateWizard({ ctx, identityId, templates, defaultTemplateId, onClose, onCreated }: {
  ctx: ForwardContext | null;
  identityId: string;
  templates: ForwardTemplate[];
  defaultTemplateId?: string;
  onClose: () => void;
  onCreated: (batch: ForwardBatch) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mode, setMode] = useState<'form' | 'file'>('form');
  // 表单模式
  const [formTemplateId, setFormTemplateId] = useState(defaultTemplateId || templates[0]?.id || '');
  const [formRows, setFormRows] = useState<Array<{ customId: string; input: string }>>([
    { customId: 'task-001', input: '' },
  ]);
  // 文件模式
  const [fileName, setFileName] = useState('');
  const [validation, setValidation] = useState<JsonlValidation | null>(null);
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  // 最终确定的任务行（进入 Step 2 时生成）
  const [finalLines, setFinalLines] = useState<BatchInputLine[]>([]);
  // Step 2 上传
  const [uploading, setUploading] = useState(false);
  const [uploadedFileId, setUploadedFileId] = useState('');
  const [uploadedName, setUploadedName] = useState('');
  const [uploadedSize, setUploadedSize] = useState(0);
  // Step 3 提交
  const [window_, setWindow_] = useState<BatchCompletionWindow>('24h');
  // 自定义标签（API 层对应 metadata）：逐项键值对输入，避免用户面对裸 JSON 不知所措
  const [metaRows, setMetaRows] = useState<Array<{ key: string; value: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const formLines: BatchInputLine[] = formRows
    .filter((r) => r.input.trim())
    .map((r) => ({
      custom_id: r.customId.trim(),
      template_id: formTemplateId,
      identity_id: identityId,
      body: { input: r.input.trim() },
    }));

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    const text = await file.text();
    setValidation(validateJsonl(text, identityId));
    setShowErrorDetail(false);
  }, [identityId]);

  // 下载示例 JSONL（预填当前身份与模板 ID，降低 ID 门槛）
  const handleDownloadSample = useCallback(() => {
    const sample: BatchInputLine[] = [1, 2].map((i) => ({
      custom_id: `task-00${i}`,
      template_id: formTemplateId || templates[0]?.id || 'tmpl_xxx',
      identity_id: identityId,
      body: { input: i === 1 ? '你好' : '帮我写一首关于夏天的短诗' },
    }));
    const blob = new Blob([linesToJsonl(sample)], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, 'batch_input_sample.jsonl');
    URL.revokeObjectURL(url);
  }, [formTemplateId, templates, identityId]);

  const step1Lines = mode === 'form' ? formLines : (validation?.okLines ?? []);
  const step1Ready = step1Lines.length > 0 &&
    (mode === 'form' ? formLines.every((l) => l.custom_id) : true);

  const goStep2 = useCallback(async () => {
    if (!ctx || step1Lines.length === 0) return;
    setError('');
    setFinalLines(step1Lines);
    setStep(2);
    // 进入 Step 2 时自动上传
    setUploading(true);
    try {
      const jsonl = linesToJsonl(step1Lines);
      const name = mode === 'file' && fileName ? fileName : `batch_input_${Date.now()}.jsonl`;
      const file = new File([jsonl], name, { type: 'application/jsonl' });
      const uploaded = await uploadCloudFile(ctx, { file, purpose: 'session_resource' });
      setUploadedFileId(uploaded.id);
      setUploadedName(uploaded.filename || name);
      setUploadedSize(uploaded.size_bytes ?? jsonl.length);
    } catch (err) {
      setError(`上传失败：${err instanceof Error ? err.message : String(err)}。请点击「重试上传」`);
    } finally {
      setUploading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, step1Lines, mode, fileName]);

  const retryUpload = useCallback(async () => {
    if (!ctx || finalLines.length === 0) return;
    setError('');
    setUploading(true);
    try {
      const jsonl = linesToJsonl(finalLines);
      const name = mode === 'file' && fileName ? fileName : `batch_input_${Date.now()}.jsonl`;
      const file = new File([jsonl], name, { type: 'application/jsonl' });
      const uploaded = await uploadCloudFile(ctx, { file, purpose: 'session_resource' });
      setUploadedFileId(uploaded.id);
      setUploadedName(uploaded.filename || name);
      setUploadedSize(uploaded.size_bytes ?? jsonl.length);
    } catch (err) {
      setError(`上传失败：${err instanceof Error ? err.message : String(err)}。请点击「重试上传」`);
    } finally {
      setUploading(false);
    }
  }, [ctx, finalLines, mode, fileName]);

  const handleSubmit = useCallback(async () => {
    if (!ctx || !uploadedFileId) return;
    setError('');
    // 自定义标签静默校验，仅超限时提示具体原因（约束来自 API metadata 字段）
    let metadata: Record<string, unknown> | undefined;
    const filledRows = metaRows.filter((r) => r.key.trim());
    if (filledRows.length > 0) {
      const keys = filledRows.map((r) => r.key.trim());
      if (new Set(keys).size < keys.length) { setError('标签名重复，请检查后重试'); return; }
      if (keys.length > 16) { setError('自定义标签最多 16 条'); return; }
      if (keys.some((k) => k.length > 64)) { setError('标签名不能超过 64 字符'); return; }
      metadata = Object.fromEntries(filledRows.map((r) => [r.key.trim(), r.value]));
      if (JSON.stringify(metadata).length > 2048) { setError('标签内容总量过长，请精简'); return; }
    }
    setSubmitting(true);
    try {
      const batch = await createBatch(ctx, {
        input_file_id: uploadedFileId,
        completion_window: window_,
        ...(metadata ? { metadata } : {}),
      });
      onCreated(batch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('rate_limit') || msg.includes('429')) {
        setError('进行中的批量任务数已达上限，请等待现有任务完成或取消部分任务');
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }, [ctx, uploadedFileId, window_, metaRows, onCreated]);

  return (
    <Modal open onClose={onClose} title="创建批量任务">
      {/* 步骤指示器 */}
      <div className="mb-4 flex items-center justify-center gap-3">
        {([['1', '构建任务'], ['2', '上传确认'], ['3', '提交执行']] as const).map(([n, label], i) => (
          <div key={n} className="flex items-center gap-3">
            {i > 0 && <div className="h-px w-8 bg-black/10" />}
            <div className={`flex items-center gap-1.5 text-xs font-medium ${step === i + 1 ? 'text-[#3550FF]' : step > i + 1 ? 'text-[#3550FF]/60' : 'text-black/30'}`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${step >= i + 1 ? 'bg-[#3550FF] text-white' : 'bg-black/10 text-black/40'}`}>{n}</span>
              {label}
            </div>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-3">
          {/* Tab 切换 */}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setMode('form')} className={`rounded-lg py-2 text-xs font-medium transition ${mode === 'form' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}>📝 表单构建</button>
            <button type="button" onClick={() => setMode('file')} className={`rounded-lg py-2 text-xs font-medium transition ${mode === 'file' ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}>📄 上传文件</button>
          </div>

          {mode === 'form' && (
            <>
              <div>
                <div className="mb-1 text-[11px] font-medium text-black/50">绑定模板</div>
                <select value={formTemplateId} onChange={(e) => setFormTemplateId(e.target.value)} className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 text-sm outline-none transition focus:border-[#3550FF]">
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
                </select>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-black/50">任务列表（{formLines.length} 条）</span>
                  <button
                    type="button"
                    onClick={() => setFormRows((prev) => [...prev, { customId: `task-${String(prev.length + 1).padStart(3, '0')}`, input: '' }])}
                    className="text-[11px] font-medium text-[#3550FF] hover:underline"
                  >
                    + 添加行
                  </button>
                </div>
                <div className="max-h-[240px] space-y-1.5 overflow-y-auto">
                  {formRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        value={row.customId}
                        onChange={(e) => setFormRows((prev) => prev.map((r, j) => (j === i ? { ...r, customId: e.target.value } : r)))}
                        className="h-8 w-24 shrink-0 rounded-lg border border-[#E5E7EB] bg-white px-2 font-mono text-[11px] outline-none focus:border-[#3550FF]"
                        placeholder="task-001"
                      />
                      <input
                        value={row.input}
                        onChange={(e) => setFormRows((prev) => prev.map((r, j) => (j === i ? { ...r, input: e.target.value } : r)))}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-[#E5E7EB] bg-white px-2.5 text-xs outline-none focus:border-[#3550FF]"
                        placeholder="输入任务内容，如：帮我写一首关于夏天的短诗"
                      />
                      <button
                        type="button"
                        onClick={() => setFormRows((prev) => prev.filter((_, j) => j !== i))}
                        disabled={formRows.length <= 1}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-black/30 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {mode === 'file' && (
            <>
              <label className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-[#C9CFE3] bg-[#FAFBFF] px-4 py-6 text-center transition hover:border-[#3550FF]">
                <span className="text-xl">⬆</span>
                <span className="text-xs font-medium text-black/60">{fileName || '拖拽 .jsonl 文件到此处，或点击选择'}</span>
                <span className="text-[11px] text-black/35">每行一个 JSON 任务，最多 10,000 行</span>
                <input
                  type="file"
                  accept=".jsonl,.json,.txt"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }}
                />
              </label>
              <button type="button" onClick={handleDownloadSample} className="text-[11px] font-medium text-[#3550FF] hover:underline">
                ⬇ 下载示例 JSONL（已预填当前身份与模板 ID）
              </button>
              {validation && (
                <div className="rounded-lg bg-[#F8F9FF] px-3 py-2 text-xs">
                  <div className="flex items-center gap-3">
                    <span className="text-emerald-600">✔ 校验通过 {validation.okLines.length} 行</span>
                    {validation.errors.length > 0 && (
                      <button type="button" onClick={() => setShowErrorDetail((v) => !v)} className="text-amber-600 hover:underline">
                        ⚠ {validation.errors.length} 行有问题 {showErrorDetail ? '收起' : '查看明细'}
                      </button>
                    )}
                  </div>
                  {validation.autoFilledIdentity > 0 && (
                    <div className="mt-1 text-[11px] text-black/40">已为 {validation.autoFilledIdentity} 行自动补全当前登录身份</div>
                  )}
                  {showErrorDetail && (
                    <ul className="mt-1.5 max-h-[120px] space-y-0.5 overflow-y-auto text-[11px] text-amber-700">
                      {validation.errors.slice(0, 50).map((e, i) => (
                        <li key={i}>· {e.line > 0 ? `第 ${e.line} 行：` : ''}{e.reason}</li>
                      ))}
                    </ul>
                  )}
                  {validation.errors.length > 0 && validation.okLines.length > 0 && (
                    <div className="mt-1 text-[11px] text-black/40">可忽略问题行继续（正式提交时服务端会将校验失败行写入 error.jsonl），或修改文件后重新上传</div>
                  )}
                </div>
              )}
            </>
          )}

          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-500">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-xs font-medium text-black/60 transition hover:bg-gray-50">取消</button>
            <button
              onClick={() => void goStep2()}
              disabled={!step1Ready}
              className="rounded-lg bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
            >
              下一步 →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          {uploading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-black/50">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#D7DBEA] border-t-[#3550FF]" />
              正在上传任务文件...
            </div>
          ) : uploadedFileId ? (
            <>
              <div className="rounded-lg bg-[#F8F9FF] px-3 py-2.5">
                <div className="text-xs font-medium text-black/70">⬆ 已上传：{uploadedName}</div>
                <div className="mt-0.5 text-[11px] text-black/40">{finalLines.length} 行 · {(uploadedSize / 1024).toFixed(1)} KB</div>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-medium text-black/50">内容预览（前 5 行）</div>
                <pre className="max-h-[160px] overflow-auto rounded-lg border border-[#E5E7EB] bg-[#FAFAFA] p-2.5 font-mono text-[10px] leading-4 text-black/60">
                  {finalLines.slice(0, 5).map((l) => JSON.stringify(l)).join('\n')}
                  {finalLines.length > 5 ? '\n…' : ''}
                </pre>
              </div>
            </>
          ) : (
            <div className="py-4 text-center">
              <button onClick={() => void retryUpload()} className="rounded-lg bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0]">重试上传</button>
            </div>
          )}
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-500">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => { setStep(1); setError(''); }} className="rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-xs font-medium text-black/60 transition hover:bg-gray-50">← 上一步</button>
            <button
              onClick={() => setStep(3)}
              disabled={!uploadedFileId || uploading}
              className="rounded-lg bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
            >
              下一步 →
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-black/50">完成窗口</div>
            <div className="grid grid-cols-3 gap-2">
              {COMPLETION_WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWindow_(w)}
                  className={`rounded-lg py-2 text-xs font-medium transition ${window_ === w ? 'bg-[#3550FF] text-white' : 'bg-[#F4F6FC] text-black/55 hover:bg-[#E8EBF5]'}`}
                >
                  {w}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[11px] text-black/35">超过完成窗口未执行完的任务将标记为已过期</div>
          </div>
          <details>
            <summary className="cursor-pointer text-[11px] font-medium text-black/50">▸ 自定义标签（可选）</summary>
            <div className="mt-1.5 space-y-1.5">
              <div className="text-[11px] leading-4 text-black/40">为这批任务添加备注标签（如「用途：月度报表」），仅用于标识和查找，不影响任务执行。</div>
              {metaRows.map((row, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    value={row.key}
                    onChange={(e) => setMetaRows((prev) => prev.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    className="h-8 w-28 shrink-0 rounded-lg border border-[#E5E7EB] bg-white px-2 text-xs outline-none focus:border-[#3550FF]"
                    placeholder="标签名，如：用途"
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setMetaRows((prev) => prev.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[#E5E7EB] bg-white px-2.5 text-xs outline-none focus:border-[#3550FF]"
                    placeholder="内容，如：月度报表"
                  />
                  <button
                    type="button"
                    onClick={() => setMetaRows((prev) => prev.filter((_, j) => j !== i))}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-black/30 transition hover:bg-red-50 hover:text-red-500"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setMetaRows((prev) => [...prev, { key: '', value: '' }])}
                disabled={metaRows.length >= 16}
                className="text-[11px] font-medium text-[#3550FF] hover:underline disabled:opacity-40"
              >
                + 添加标签
              </button>
            </div>
          </details>
          <div className="rounded-lg bg-[#F0F4FF] px-3 py-2 text-[11px] leading-4 text-black/50">
            ℹ 提交后任务进入校验队列，将在平台闲时时段自动调度执行
          </div>
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-500">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => { setStep(2); setError(''); }} className="rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-xs font-medium text-black/60 transition hover:bg-gray-50">← 上一步</button>
            <button
              onClick={() => void handleSubmit()}
              disabled={submitting || !uploadedFileId}
              className="rounded-lg bg-[#3550FF] px-4 py-2 text-xs font-medium text-white transition hover:bg-[#2a42e0] disabled:opacity-50"
            >
              {submitting ? '提交中...' : '提交批量任务'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
