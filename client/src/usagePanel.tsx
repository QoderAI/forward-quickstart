import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listIdentityUsage,
  listSessionsPage,
  listTemplateUsage,
  type ForwardContext,
  type ForwardSession,
  type IdentityUsageRow,
  type TemplateUsageRow,
} from './forwardApi';
import {
  DASH,
  WINDOW_PRESETS,
  averageCredits,
  dailyCreditSeries,
  dayLabel,
  formatCount,
  formatCredits,
  formatDuration,
  resolveWindow,
  sessionCredits,
  sumSessionCredits,
  templateBreakdown,
  toRfc3339,
  type WindowPreset,
} from './credits';

const PAGE_SIZE = 100;

function sessionStatusLabel(status?: string) {
  const s = status?.replace(/^status_/, '');
  if (s === 'running' || s === 'processing') return '进行中';
  if (s === 'idle' || s === 'completed') return '已完成';
  if (s === 'failed') return '失败';
  if (s === 'cancelled' || s === 'canceled' || s === 'canceling' || s === 'cancelling') return '已取消';
  if (s === 'terminated') return '已终止';
  return s || '未知';
}

function sessionStatusBadgeClass(status?: string) {
  const s = status?.replace(/^status_/, '');
  if (s === 'running' || s === 'processing') return 'border-[#B8C3FF] bg-[#EEF1FF] text-[#3550FF]';
  if (s === 'failed') return 'border-[#FFD0D0] bg-[#FFF1F1] text-[#D92D20]';
  if (s === 'cancelled' || s === 'canceled' || s === 'canceling' || s === 'cancelling') return 'border-[#FFE3B8] bg-[#FFF8ED] text-[#B54708]';
  return 'border-[#DDE2F2] bg-[#F7F8FC] text-black/55';
}

function displayDateTime(value?: string) {
  if (!value) return DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString();
}

/** One headline number. */
function StatCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-[inset_0_0_0_1px_#2F3A801A]">
      <div className="text-xs text-black/45">{label}</div>
      <div className={`mt-4 text-3xl font-semibold tabular-nums ${accent ? 'text-[#3550FF]' : 'text-black'}`}>{value}</div>
      {hint && <div className="mt-1.5 text-[11px] text-black/35">{hint}</div>}
    </div>
  );
}

type SortKey = 'credits' | 'created_at';

export function UsagePanel({ ctx, identityId, displayName, getModelLabel }: {
  ctx: ForwardContext | null;
  identityId: string;
  displayName: string;
  /** 模型展示名解析（复用 App 侧基于 cloudModels 的逻辑） */
  getModelLabel?: (model: unknown) => string;
}) {
  const [preset, setPreset] = useState<WindowPreset>('last30');
  const [identityRow, setIdentityRow] = useState<IdentityUsageRow | null>(null);
  const [templateRows, setTemplateRows] = useState<TemplateUsageRow[]>([]);
  const [sessions, setSessions] = useState<ForwardSession[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('credits');

  // Recomputed per preset change; `resolveWindow` clamps to the API's 31-day cap.
  // Not named `window`: that would shadow the global used for timers below.
  const activeWindow = useMemo(() => resolveWindow(preset), [preset]);

  const load = useCallback(async () => {
    if (!ctx || !identityId) return;
    setLoading(true);
    setError('');
    try {
      const { startMs, endMs } = resolveWindow(preset);
      // The authoritative totals and the itemized ledger come from different
      // endpoints, so fetch them together rather than serially.
      const [identityUsage, templateUsage, page] = await Promise.all([
        listIdentityUsage(ctx, { startMs, endMs, identityId }),
        listTemplateUsage(ctx, { startMs, endMs, identityId }),
        listSessionsPage(ctx, {
          identityIds: identityId,
          createdAtGte: toRfc3339(startMs),
          createdAtLte: toRfc3339(endMs),
          limit: PAGE_SIZE,
          includeArchived: true,
          order: 'desc',
        }),
      ]);
      setIdentityRow(identityUsage.data?.[0] ?? null);
      setTemplateRows(templateUsage.data ?? []);
      setSessions(page.data ?? []);
      setHasMore(Boolean(page.has_more));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIdentityRow(null);
      setTemplateRows([]);
      setSessions([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [ctx, identityId, preset]);

  const loadMore = useCallback(async () => {
    if (!ctx || !identityId || sessions.length === 0) return;
    setLoadingMore(true);
    setError('');
    try {
      const { startMs, endMs } = resolveWindow(preset);
      const page = await listSessionsPage(ctx, {
        identityIds: identityId,
        createdAtGte: toRfc3339(startMs),
        createdAtLte: toRfc3339(endMs),
        limit: PAGE_SIZE,
        afterId: sessions[sessions.length - 1]?.id,
        includeArchived: true,
        order: 'desc',
      });
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...(page.data ?? []).filter((s) => !seen.has(s.id))];
      });
      setHasMore(Boolean(page.has_more));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [ctx, identityId, preset, sessions]);

  // Deferred by a 0ms timer for the same reason batchPanel does it: the loader
  // flips loading state synchronously, which must not happen inside the effect body.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // ── Derived views ──
  // Headline credits come from the aggregate endpoint, never from summing the
  // table: with pagination the table may hold only part of the window.
  const totalCredits = identityRow?.credits ?? null;
  const creditsUnavailable = identityRow != null && identityRow.credits == null;
  const sessionCount = identityRow?.session_count ?? null;
  const durationSeconds = identityRow?.duration_seconds ?? null;
  const avgPerSession = useMemo(() => averageCredits(sessions), [sessions]);
  const ledgerSum = useMemo(() => sumSessionCredits(sessions), [sessions]);

  const series = useMemo(() => dailyCreditSeries(sessions, activeWindow), [sessions, activeWindow]);
  const peak = useMemo(() => series.reduce((max, d) => Math.max(max, d.credits), 0), [series]);

  const templateNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      const id = s.template?.id || s.template_id;
      if (id && s.template?.name) map.set(id, s.template.name);
    }
    return map;
  }, [sessions]);

  const breakdown = useMemo(
    () => templateBreakdown(
      templateRows.map((r) => ({ template_id: r.template_id, credits: r.credits, session_count: r.session_count })),
      templateNames,
    ),
    [templateRows, templateNames],
  );

  const sortedSessions = useMemo(() => {
    const rows = [...sessions];
    if (sortKey === 'credits') {
      // Unknown-credit rows sort last: they are not "cheap", just unmeasured.
      rows.sort((a, b) => (sessionCredits(b) ?? -1) - (sessionCredits(a) ?? -1));
    } else {
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    return rows;
  }, [sessions, sortKey]);

  // The trend and the average are derived from loaded rows only, so say so when
  // the window holds more than we have.
  const partial = sessionCount != null && sessions.length < sessionCount;

  return (
    <div className="h-full overflow-y-auto bg-[#FAFBFF]">
      <div className="flex max-w-[1440px] flex-col gap-5 p-6">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-medium text-black">我的用量</h1>
          <span className="font-mono text-xs text-black/40">{displayName}</span>
        </div>

        {/* Window presets. No free-form range picker: the API caps a window at 31
            days, and these presets can never breach it. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {WINDOW_PRESETS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setPreset(value)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                  preset === value ? 'bg-[#3550FF] text-white' : 'bg-white text-black/55 shadow-[inset_0_0_0_1px_#2F3A801A] hover:text-black'
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-2 font-mono text-[11px] text-black/30">
              {new Date(activeWindow.startMs).toLocaleDateString()} – {new Date(activeWindow.endMs).toLocaleDateString()}
            </span>
          </div>
          <button
            onClick={() => void load()}
            disabled={!ctx || loading}
            className="rounded-full border border-[#D9DCEA] bg-white px-4 py-2 text-xs font-medium text-black/65 transition hover:bg-[#F8F9FC] disabled:opacity-45"
          >
            {loading ? '加载中...' : '刷新'}
          </button>
        </div>

        {error && <div className="rounded-xl border border-[#fecaca] bg-[#fef2f2] px-4 py-2.5 text-xs text-[#b42318]">{error}</div>}

        {creditsUnavailable && (
          <div className="rounded-xl border border-[#FFE3B8] bg-[#FFF8ED] px-4 py-2.5 text-xs text-[#B54708]">
            Credit 数据当前不可用（接口返回空值），下方消耗金额仅供参考。
          </div>
        )}

        {/* 1. How much */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="消耗 Credit"
            value={formatCredits(totalCredits)}
            hint={identityRow ? '来自官方用量汇总' : undefined}
            accent
          />
          <StatCard label="会话数" value={formatCount(sessionCount)} />
          <StatCard
            label="平均每会话"
            value={formatCredits(avgPerSession)}
            hint={partial ? `基于已加载 ${sessions.length} 条` : undefined}
          />
          <StatCard label="运行时长" value={formatDuration(durationSeconds)} />
        </div>

        {/* 2. Trend */}
        <div className="rounded-2xl bg-white p-5 shadow-[inset_0_0_0_1px_#2F3A801A]">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-black">每日消耗</h2>
            <span className="text-[11px] text-black/35">
              {partial ? `基于已加载 ${sessions.length} 条记录` : '按会话创建日聚合'}
            </span>
          </div>
          {series.length === 0 ? (
            <div className="py-8 text-center text-xs text-black/35">该时间段暂无消耗</div>
          ) : (
            // Bars and labels are separate rows on purpose: a percentage height
            // only resolves against a parent with a definite height, so the bar
            // track gets a fixed h-28 of its own rather than sharing an
            // auto-height column with the label (which collapsed the bars to 0).
            <div>
              <div className="flex h-28 items-end gap-1">
                {series.map((d) => (
                  <div
                    key={d.date}
                    className="group flex h-full min-w-0 flex-1 items-end"
                    title={`${d.date} · ${formatCredits(d.credits)} Credit · ${d.sessions} 个会话`}
                  >
                    <div
                      className={`w-full rounded-t transition ${d.credits > 0 ? 'bg-[#3550FF]/75 group-hover:bg-[#3550FF]' : 'bg-[#EDEEF6]'}`}
                      style={{ height: peak > 0 && d.credits > 0 ? `${Math.max((d.credits / peak) * 100, 2)}%` : '2px' }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex gap-1">
                {series.map((d) => (
                  <span key={d.date} className="min-w-0 flex-1 truncate text-center text-[9px] leading-none text-black/30">
                    {dayLabel(d.date)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 3. Attribution */}
        {breakdown.length > 0 && (
          <div className="rounded-2xl bg-white p-5 shadow-[inset_0_0_0_1px_#2F3A801A]">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-black">按模板消耗</h2>
              <span className="text-[11px] text-black/35">来自官方用量汇总</span>
            </div>
            <div className="flex flex-col gap-3">
              {breakdown.map((t) => (
                <div key={t.templateId} className="flex items-center gap-3">
                  <div className="w-40 shrink-0 truncate text-xs text-black/70" title={t.name}>{t.name}</div>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[#F1F3FA]">
                    <div className="h-full rounded-full bg-[#3550FF]/70" style={{ width: `${Math.max(t.share * 100, t.credits ? 1.5 : 0)}%` }} />
                  </div>
                  <div className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-black/75">{formatCredits(t.credits)}</div>
                  <div className="w-16 shrink-0 text-right text-[11px] text-black/35">{formatCount(t.sessionCount)} 会话</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 4. The ledger */}
        <div className="rounded-2xl bg-white p-5 shadow-[inset_0_0_0_1px_#2F3A801A]">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-black">Credit 消耗记录</h2>
              <p className="mt-1 text-xs text-black/40">
                按会话逐条列出该时间段的 Credit 消耗
                {ledgerSum.unknown > 0 && `，其中 ${ledgerSum.unknown} 条无 Credit 数据`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-black/35">
                已加载 {formatCount(sessions.length)}
                {sessionCount != null && ` / 共 ${formatCount(sessionCount)}`} 条
                <span className="mx-1.5 text-black/20">·</span>
                小计 {formatCredits(ledgerSum.total)}
              </span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="h-8 rounded-lg border border-[#E5E7EB] bg-white px-2 text-xs text-black/60 outline-none transition focus:border-[#3550FF]"
              >
                <option value="credits">按 Credit 降序</option>
                <option value="created_at">按时间降序</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[960px] w-full border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr className="text-xs text-black/40">
                  <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">Session</th>
                  <th className="border-b border-[#EEF1F7] px-3 py-3 text-right font-medium">Credit</th>
                  <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">模板</th>
                  <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">模型</th>
                  <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">状态</th>
                  <th className="border-b border-[#EEF1F7] px-3 py-3 font-medium">开始时间</th>
                </tr>
              </thead>
              <tbody>
                {sortedSessions.map((session) => {
                  const credits = sessionCredits(session);
                  return (
                    <tr key={`credit-${session.id}`} className="text-xs text-black/65">
                      <td className="max-w-[300px] border-b border-[#F2F4FA] px-3 py-3">
                        <div className="truncate font-medium text-black" title={session.title || session.id}>
                          {session.title || 'Forward 会话'}
                        </div>
                        <div className="mt-1 truncate font-mono text-[11px] text-black/35" title={session.id}>{session.id}</div>
                      </td>
                      <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3 text-right font-mono tabular-nums">
                        {credits == null
                          ? <span className="text-black/30" title="该会话无 Credit 数据">{DASH}</span>
                          : <span className={credits > 0 ? 'font-semibold text-black' : 'text-black/45'}>{formatCredits(credits)}</span>}
                      </td>
                      <td className="max-w-[180px] border-b border-[#F2F4FA] px-3 py-3">
                        <span className="truncate" title={session.template?.name || session.template_id}>
                          {session.template?.name || session.template_id || DASH}
                        </span>
                      </td>
                      <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3">
                        {/* Resolved through the App-side cloudModels lookup so this
                            shows a display name rather than a raw id like "cmodel". */}
                        {session.template?.model
                          ? <span className="text-black/60">{getModelLabel ? getModelLabel(session.template.model) : session.template.model}</span>
                          : <span className="text-black/30">{DASH}</span>}
                      </td>
                      <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3">
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium ${sessionStatusBadgeClass(session.status)}`}>
                          {sessionStatusLabel(session.status)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap border-b border-[#F2F4FA] px-3 py-3 font-mono text-[11px]">
                        {displayDateTime(session.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {loading && sessions.length === 0 && (
            <div className="flex justify-center py-10">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-[#D7DBEA] border-t-[#3550FF]" />
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-black/35">该时间段暂无消耗记录</div>
          )}

          {hasMore && sessions.length > 0 && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-full border border-[#DDE2F2] bg-white px-4 py-2 text-xs text-black/60 transition hover:border-[#3550FF] hover:text-[#3550FF] disabled:opacity-50"
              >
                {loadingMore ? '加载中...' : '加载更多'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
