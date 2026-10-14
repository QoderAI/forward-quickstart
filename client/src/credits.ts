// Credit accounting helpers for the usage panel.
//
// Field choice is driven by live-API behaviour, not the docs. The docs recommend
// session.usage.total_credits, but against the live international endpoint:
//   - usage.credits was present on 25/25 sessions and its sum matched the
//     official /usage/identities aggregate EXACTLY (5182.49);
//   - usage.total_credits was present on only 1/25 and did NOT reconcile
//     (434.74 + 803.43 = 1238.17 vs the official 1238.15).
// So `credits` is authoritative here and `total_credits` is only a fallback.
//
// Two other live findings shape this file:
//   - credit values carry float noise (815.4300000000001, 872.0799999999999),
//     so every displayed number must be rounded;
//   - the aggregate's `credits` can be null when credit lookup is unavailable,
//     which is NOT the same as zero and must never render as 0.

/** The usage shape as it actually comes back from the Forward API. */
export interface SessionUsage {
  credits?: number | null;
  total_credits?: number | null;
}

export interface CreditSession {
  id: string;
  title?: string;
  status?: string;
  created_at: string;
  template?: { id?: string; name?: string };
  usage?: SessionUsage;
}

/** Missing-value placeholder, matching the rest of the app. */
export const DASH = '—';

/**
 * Credits consumed by one session, or null when genuinely unknown.
 *
 * Returning null rather than 0 is the whole point: "credit lookup unavailable"
 * and "this session was free" are different facts, and collapsing them would
 * silently understate spend.
 */
export function sessionCredits(session: { usage?: SessionUsage }): number | null {
  const usage = session.usage;
  if (!usage) return null;
  if (typeof usage.credits === 'number' && Number.isFinite(usage.credits)) return usage.credits;
  if (typeof usage.total_credits === 'number' && Number.isFinite(usage.total_credits)) return usage.total_credits;
  return null;
}

/** Round to 2 decimals, killing the float noise the API returns. */
export function roundCredits(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Display form: 2 decimals + thousands separators, DASH when unknown. */
export function formatCredits(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  return roundCredits(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Compact integer display for counts. */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  return value.toLocaleString('en-US');
}

/** Seconds → "45s" / "12m 3s" / "2h 5m", matching sessionDuration() in App.tsx. */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return DASH;
  const whole = Math.floor(seconds);
  if (seconds < 60) return `${Number(seconds.toFixed(3))}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

// ─── Time window ──────────────────────────────────────────────────
// Usage uses whole hours in Asia/Shanghai, including in the Global region.
export const MAX_WINDOW_DAYS = 31;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * DAY_MS;

/** API-local hourly timestamp, without a timezone suffix. */
export function toUsageHour(ms: number): string {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 19);
}

export type WindowPreset = 'last7' | 'last30' | 'thisMonth';

export const WINDOW_PRESETS: Array<{ value: WindowPreset; label: string }> = [
  { value: 'last7', label: '近 7 天' },
  { value: 'last30', label: '近 30 天' },
  { value: 'thisMonth', label: '本月' },
];

export interface CreditWindow {
  /** Unix ms, inclusive. */
  startMs: number;
  /** Unix ms, exclusive. */
  endMs: number;
}

/**
 * Resolve a preset into a concrete window.
 *
 * `now` is injectable so this stays a pure function and can be tested without
 * freezing the clock.
 */
export function resolveWindow(preset: WindowPreset, now: number = Date.now()): CreditWindow {
  const endMs = Math.floor(now / HOUR_MS) * HOUR_MS;
  let startMs: number;
  if (preset === 'thisMonth') {
    const local = new Date(endMs + SHANGHAI_OFFSET_MS);
    startMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS;
  } else {
    startMs = endMs - (preset === 'last7' ? 7 : 30) * DAY_MS;
  }
  return clampWindow({ startMs, endMs });
}

/** Pull `startMs` forward if the span would exceed the API's 31-day ceiling. */
export function clampWindow(window: CreditWindow): CreditWindow {
  const { endMs } = window;
  const startMs = Math.min(window.startMs, endMs);
  if (endMs - startMs > MAX_WINDOW_MS) return { startMs: endMs - MAX_WINDOW_MS, endMs };
  return { startMs, endMs };
}

/** RFC 3339 form for the ListSessions created_at[gte]/[lt] filters, which take
 *  RFC 3339 timestamps rather than Usage local-hour strings. */
export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Derived series ───────────────────────────────────────────────
// There is no time-series endpoint (no granularity/group_by anywhere), so a
// daily trend is aggregated client-side from the session rows already fetched.
// That costs 0 extra requests, where per-day querying would cost up to 31.

export interface DailyCredits {
  /** Asia/Shanghai calendar day, YYYY-MM-DD. */
  date: string;
  credits: number;
  sessions: number;
}

function usageDayKey(ms: number): string {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Per-day credit totals across the window, including days with no activity —
 * gaps have to be zero-filled or the bars would misrepresent the shape of
 * spending by silently compressing quiet days out of the axis.
 */
export function dailyCreditSeries(sessions: CreditSession[], window?: CreditWindow): DailyCredits[] {
  if (window && window.startMs >= window.endMs) return [];
  const buckets = new Map<string, { credits: number; sessions: number }>();
  for (const session of sessions) {
    const ms = new Date(session.created_at).getTime();
    if (!Number.isFinite(ms) || (window && (ms < window.startMs || ms >= window.endMs))) continue;
    const key = usageDayKey(ms);
    const bucket = buckets.get(key) ?? { credits: 0, sessions: 0 };
    bucket.credits += sessionCredits(session) ?? 0;
    bucket.sessions += 1;
    buckets.set(key, bucket);
  }

  const keys = [...buckets.keys()].sort();
  // Prefer the requested window as the axis; fall back to the observed range.
  const firstMs = window ? window.startMs : keys.length ? new Date(`${keys[0]}T00:00:00+08:00`).getTime() : NaN;
  const lastMs = window ? window.endMs - 1 : keys.length ? new Date(`${keys[keys.length - 1]}T00:00:00+08:00`).getTime() : NaN;
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return [];

  const out: DailyCredits[] = [];
  const startDay = Math.floor((firstMs + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
  for (let cursor = startDay, i = 0; cursor <= lastMs && i <= MAX_WINDOW_DAYS + 1; cursor += DAY_MS, i += 1) {
    const key = usageDayKey(cursor);
    const bucket = buckets.get(key);
    out.push({ date: key, credits: roundCredits(bucket?.credits ?? 0), sessions: bucket?.sessions ?? 0 });
  }
  return out;
}

export interface TemplateCredits {
  templateId: string;
  name: string;
  credits: number | null;
  sessionCount: number;
  /** Share of the window total, 0..1. Null credits contribute no share. */
  share: number;
}

/**
 * Per-template attribution, biggest spender first. Names are resolved from the
 * session rows because the usage endpoint returns only template ids.
 */
export function templateBreakdown(
  rows: Array<{ template_id: string; credits: number | null; session_count: number }>,
  nameById: Map<string, string> = new Map(),
): TemplateCredits[] {
  const total = rows.reduce((sum, r) => sum + (r.credits ?? 0), 0);
  return rows
    .map((r) => ({
      templateId: r.template_id,
      name: nameById.get(r.template_id) || r.template_id,
      credits: r.credits,
      sessionCount: r.session_count,
      share: total > 0 && r.credits != null ? r.credits / total : 0,
    }))
    .sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1));
}

/**
 * Sum of the itemized rows. Kept separate from the authoritative aggregate on
 * purpose: with pagination this may cover only part of the window, so it is used
 * for reconciliation and derived stats, never as the headline total.
 */
export function sumSessionCredits(sessions: CreditSession[]): { total: number; counted: number; unknown: number } {
  let total = 0;
  let counted = 0;
  let unknown = 0;
  for (const session of sessions) {
    const credits = sessionCredits(session);
    if (credits == null) { unknown += 1; continue; }
    total += credits;
    counted += 1;
  }
  return { total: roundCredits(total), counted, unknown };
}

/** Mean credits per session over the rows that actually reported a value. */
export function averageCredits(sessions: CreditSession[]): number | null {
  const { total, counted } = sumSessionCredits(sessions);
  if (counted === 0) return null;
  return roundCredits(total / counted);
}

/** Short label for a day key, e.g. "8-11". */
export function dayLabel(date: string): string {
  const [, m, d] = date.split('-');
  return m && d ? `${Number(m)}-${Number(d)}` : date;
}

// ─── Per-reply model-call attribution ─────────────────────────────
// Each `span.model_request_end` event carries one model call's credit spend in
// `model_usage.credits`, but it has NO turn_id — so a call can't be mapped to a
// reply by id. Attribution is positional instead: the model calls belonging to
// an `agent.message` are those between the previous message boundary
// (the prior agent.message / user.message) and this one. Rendering derives the
// cost from the events array directly, so live and refreshed history share one
// path with no extra per-message state.

export interface ModelCall {
  /** 1-based call index within the reply. */
  index: number;
  /** Credit spend, or null when the event carried no usable number. */
  credits: number | null;
  /** The API flagged this call as failed. The spend still counts. */
  isError: boolean;
  /** processed_at timestamp, when present. */
  at?: string;
}

/** Minimal event shape needed for attribution — keeps this file free of the
 *  full ForwardEvent type and trivially unit-testable. */
interface CreditEvent {
  type: string;
  model_usage?: { credits?: number };
  is_error?: boolean;
  processed_at?: string;
}

/**
 * Model calls attributed to the agent.message at `messageIndex`.
 *
 * Walks backwards from just before the message, collecting
 * `span.model_request_end` events, and stops at the previous reply boundary
 * (an earlier agent.message or a user.message) so turns never bleed into each
 * other. Returns calls in chronological order, 1-indexed.
 *
 * `total` is null when the reply has no call with a usable credit number, which
 * is the signal to render no icon at all (never a "0").
 */
export function modelCallsForMessage(
  events: CreditEvent[],
  messageIndex: number,
): { calls: ModelCall[]; total: number | null } {
  const collected: CreditEvent[] = [];
  for (let i = messageIndex - 1; i >= 0; i -= 1) {
    const type = events[i]?.type;
    // Stop at the previous reply boundary.
    if (type === 'agent.message' || type === 'user.message') break;
    if (type === 'span.model_request_end') collected.push(events[i]);
  }
  // Collected newest-first while walking back; flip to chronological.
  collected.reverse();

  const calls: ModelCall[] = collected.map((event, i) => {
    const raw = event.model_usage?.credits;
    const credits = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return {
      index: i + 1,
      credits,
      isError: event.is_error === true,
      at: event.processed_at,
    };
  });

  // Sum the calls that reported a number. Failed calls still count — the spend
  // was incurred. Round once at the end to kill accumulated float noise.
  let total: number | null = null;
  for (const call of calls) {
    if (call.credits == null) continue;
    total = (total ?? 0) + call.credits;
  }
  return { calls, total: total == null ? null : roundCredits(total) };
}
