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
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

// ─── Time window ──────────────────────────────────────────────────
// The usage endpoints reject any span over 31 days with
// 400 "time range must not exceed 31 days" (verified live), so every window this
// module produces is clamped below that ceiling before it can reach the API.

export const MAX_WINDOW_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
// Stay a whisker under the limit: the server compares against a hard 31 days and
// an exactly-31-day span is needlessly close to the boundary.
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * DAY_MS - 1000;

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
  let startMs: number;
  if (preset === 'thisMonth') {
    const d = new Date(now);
    startMs = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  } else {
    startMs = now - (preset === 'last7' ? 7 : 30) * DAY_MS;
  }
  return clampWindow({ startMs, endMs: now });
}

/** Pull `startMs` forward if the span would exceed the API's 31-day ceiling. */
export function clampWindow(window: CreditWindow): CreditWindow {
  const { endMs } = window;
  const startMs = Math.min(window.startMs, endMs);
  if (endMs - startMs > MAX_WINDOW_MS) return { startMs: endMs - MAX_WINDOW_MS, endMs };
  return { startMs, endMs };
}

/** RFC 3339 form for the ListSessions created_at[gte]/[lte] filters, which take
 *  timestamp strings rather than the usage endpoints' Unix millis. */
export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Derived series ───────────────────────────────────────────────
// There is no time-series endpoint (no granularity/group_by anywhere), so a
// daily trend is aggregated client-side from the session rows already fetched.
// That costs 0 extra requests, where per-day querying would cost up to 31.

export interface DailyCredits {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  credits: number;
  sessions: number;
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Per-day credit totals across the window, including days with no activity —
 * gaps have to be zero-filled or the bars would misrepresent the shape of
 * spending by silently compressing quiet days out of the axis.
 */
export function dailyCreditSeries(sessions: CreditSession[], window?: CreditWindow): DailyCredits[] {
  const buckets = new Map<string, { credits: number; sessions: number }>();
  for (const session of sessions) {
    const ms = new Date(session.created_at).getTime();
    if (!Number.isFinite(ms)) continue;
    const key = localDayKey(ms);
    const bucket = buckets.get(key) ?? { credits: 0, sessions: 0 };
    bucket.credits += sessionCredits(session) ?? 0;
    bucket.sessions += 1;
    buckets.set(key, bucket);
  }

  const keys = [...buckets.keys()].sort();
  // Prefer the requested window as the axis; fall back to the observed range.
  const firstMs = window ? window.startMs : keys.length ? new Date(`${keys[0]}T00:00:00`).getTime() : NaN;
  const lastMs = window ? window.endMs : keys.length ? new Date(`${keys[keys.length - 1]}T00:00:00`).getTime() : NaN;
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return [];

  const out: DailyCredits[] = [];
  const cursor = new Date(firstMs);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(lastMs);
  end.setHours(0, 0, 0, 0);
  // Guard against a pathological window producing an unbounded loop.
  for (let i = 0; cursor.getTime() <= end.getTime() && i <= MAX_WINDOW_DAYS + 1; i += 1) {
    const key = localDayKey(cursor.getTime());
    const bucket = buckets.get(key);
    out.push({
      date: key,
      credits: roundCredits(bucket?.credits ?? 0),
      sessions: bucket?.sessions ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
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
