import { describe, expect, test } from 'vitest';
import {
  DASH,
  MAX_WINDOW_DAYS,
  averageCredits,
  clampWindow,
  dailyCreditSeries,
  dayLabel,
  formatCount,
  formatCredits,
  formatDuration,
  resolveWindow,
  roundCredits,
  sessionCredits,
  sumSessionCredits,
  templateBreakdown,
  toRfc3339,
} from './credits';

const DAY = 24 * 60 * 60 * 1000;

const session = (over: Partial<Parameters<typeof sessionCredits>[0]> & { id?: string; created_at?: string } = {}) => ({
  id: 'sess_x',
  created_at: '2026-08-01T03:00:00Z',
  ...over,
});

describe('sessionCredits', () => {
  test('prefers usage.credits, which is the field that reconciles with the official aggregate', () => {
    // Live: summing usage.credits matched /usage/identities exactly (1238.15),
    // whereas preferring total_credits drifted to 1238.17.
    expect(sessionCredits({ usage: { credits: 803.41, total_credits: 803.43 } })).toBe(803.41);
  });

  test('falls back to total_credits when credits is absent', () => {
    expect(sessionCredits({ usage: { total_credits: 12.5 } })).toBe(12.5);
  });

  test('returns null — not 0 — when credits are unknown', () => {
    // Conflating "unavailable" with "free" would understate real spend.
    expect(sessionCredits({})).toBeNull();
    expect(sessionCredits({ usage: {} })).toBeNull();
    expect(sessionCredits({ usage: { credits: null } })).toBeNull();
  });

  test('preserves a genuine zero as 0, distinct from unknown', () => {
    // Live data really does contain sessions with credits === 0.
    expect(sessionCredits({ usage: { credits: 0 } })).toBe(0);
  });

  test('ignores non-finite values', () => {
    expect(sessionCredits({ usage: { credits: Number.NaN } })).toBeNull();
    expect(sessionCredits({ usage: { credits: Number.POSITIVE_INFINITY } })).toBeNull();
  });
});

describe('formatCredits', () => {
  test('strips the float noise the live API returns', () => {
    expect(formatCredits(815.4300000000001)).toBe('815.43');
    expect(formatCredits(872.0799999999999)).toBe('872.08');
    expect(formatCredits(205.29999999999998)).toBe('205.30');
  });

  test('adds thousands separators for large totals', () => {
    expect(formatCredits(5182.49)).toBe('5,182.49');
    expect(formatCredits(1238.15)).toBe('1,238.15');
  });

  test('always shows two decimals so a column of numbers lines up', () => {
    expect(formatCredits(137)).toBe('137.00');
    expect(formatCredits(0)).toBe('0.00');
  });

  test('renders unknown as a dash, never as zero', () => {
    expect(formatCredits(null)).toBe(DASH);
    expect(formatCredits(undefined)).toBe(DASH);
    expect(formatCredits(Number.NaN)).toBe(DASH);
  });

  test('a real zero and an unknown value look different', () => {
    expect(formatCredits(0)).not.toBe(formatCredits(null));
  });
});

describe('roundCredits', () => {
  test('rounds to two decimals', () => {
    expect(roundCredits(815.4300000000001)).toBe(815.43);
    expect(roundCredits(1.005)).toBe(1.01);
    expect(roundCredits(0)).toBe(0);
  });
});

describe('formatCount / formatDuration', () => {
  test('counts get separators and a dash fallback', () => {
    expect(formatCount(25)).toBe('25');
    expect(formatCount(12345)).toBe('12,345');
    expect(formatCount(null)).toBe(DASH);
  });

  test('durations match the existing sessionDuration format', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(2948)).toBe('49m 8s');   // live 30-day aggregate
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(0)).toBe('0s');
  });

  test('durations reject junk', () => {
    expect(formatDuration(null)).toBe(DASH);
    expect(formatDuration(-5)).toBe(DASH);
  });
});

describe('resolveWindow / clampWindow', () => {
  const now = new Date('2026-08-11T12:00:00Z').getTime();

  test('last7 spans seven days ending now', () => {
    const w = resolveWindow('last7', now);
    expect(w.endMs).toBe(now);
    expect(w.endMs - w.startMs).toBe(7 * DAY);
  });

  test('last30 stays inside the API 31-day ceiling', () => {
    const w = resolveWindow('last30', now);
    expect(w.endMs - w.startMs).toBeLessThan(MAX_WINDOW_DAYS * DAY);
  });

  test('thisMonth starts at the first of the month', () => {
    const w = resolveWindow('thisMonth', now);
    const start = new Date(w.startMs);
    expect(start.getDate()).toBe(1);
    expect(w.endMs).toBe(now);
  });

  test('every preset satisfies the 31-day server limit', () => {
    // The live endpoint 400s with "time range must not exceed 31 days".
    for (const preset of ['last7', 'last30', 'thisMonth'] as const) {
      // Check on a 31-day month, where thisMonth is at its widest.
      const end = new Date('2026-08-31T23:59:59Z').getTime();
      const w = resolveWindow(preset, end);
      expect(w.endMs - w.startMs).toBeLessThan(MAX_WINDOW_DAYS * DAY);
    }
  });

  test('an over-wide window is clamped rather than sent and rejected', () => {
    const end = now;
    const w = clampWindow({ startMs: end - 90 * DAY, endMs: end });
    expect(w.endMs - w.startMs).toBeLessThan(MAX_WINDOW_DAYS * DAY);
    expect(w.endMs).toBe(end);
  });

  test('an inverted window collapses instead of going negative', () => {
    const w = clampWindow({ startMs: now + DAY, endMs: now });
    expect(w.startMs).toBe(now);
    expect(w.endMs - w.startMs).toBe(0);
  });
});

describe('toRfc3339', () => {
  test('emits the string form ListSessions date filters expect', () => {
    // Note the two API conventions: usage endpoints take Unix millis, while
    // ListSessions created_at[gte]/[lte] take RFC 3339 strings.
    expect(toRfc3339(Date.UTC(2026, 7, 1, 0, 0, 0))).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('dailyCreditSeries', () => {
  test('buckets sessions by local day and sums their credits', () => {
    const series = dailyCreditSeries([
      session({ created_at: '2026-08-01T03:00:00Z', usage: { credits: 100 } }),
      session({ created_at: '2026-08-01T09:00:00Z', usage: { credits: 37.5 } }),
    ]);
    const day = series.find((d) => d.sessions === 2);
    expect(day?.credits).toBe(137.5);
  });

  test('zero-fills quiet days so the bars keep their true shape', () => {
    const start = new Date('2026-08-01T00:00:00').getTime();
    const end = new Date('2026-08-05T23:59:59').getTime();
    const series = dailyCreditSeries(
      [session({ created_at: '2026-08-01T03:00:00', usage: { credits: 50 } }),
       session({ created_at: '2026-08-05T03:00:00', usage: { credits: 70 } })],
      { startMs: start, endMs: end },
    );
    expect(series).toHaveLength(5);
    expect(series[0].credits).toBe(50);
    expect(series[1].credits).toBe(0);
    expect(series[1].sessions).toBe(0);
    expect(series[4].credits).toBe(70);
  });

  test('sessions with unknown credits still count as activity but add nothing', () => {
    const series = dailyCreditSeries([session({ created_at: '2026-08-01T03:00:00', usage: {} })]);
    expect(series[0].sessions).toBe(1);
    expect(series[0].credits).toBe(0);
  });

  test('no data yields an empty series rather than throwing', () => {
    expect(dailyCreditSeries([])).toEqual([]);
  });

  test('skips rows with an unparseable timestamp', () => {
    expect(dailyCreditSeries([session({ created_at: 'not-a-date', usage: { credits: 5 } })])).toEqual([]);
  });

  test('never emits an unbounded number of buckets', () => {
    const end = Date.now();
    const series = dailyCreditSeries([], { startMs: end - 365 * DAY, endMs: end });
    expect(series.length).toBeLessThanOrEqual(MAX_WINDOW_DAYS + 2);
  });
});

describe('sumSessionCredits / averageCredits', () => {
  test('reproduces the live 7-day reconciliation exactly', () => {
    // /usage/identities reported 1238.15 for these two sessions.
    const { total } = sumSessionCredits([
      session({ usage: { credits: 434.74 } }),
      session({ usage: { credits: 803.41, total_credits: 803.43 } }),
    ]);
    expect(total).toBe(1238.15);
  });

  test('reports how many rows had no credit value', () => {
    const r = sumSessionCredits([
      session({ usage: { credits: 10 } }),
      session({ usage: {} }),
      session({ usage: { credits: 0 } }),
    ]);
    expect(r.total).toBe(10);
    expect(r.counted).toBe(2);   // the real 0 counts
    expect(r.unknown).toBe(1);
  });

  test('average divides only by rows that reported a value', () => {
    expect(averageCredits([
      session({ usage: { credits: 100 } }),
      session({ usage: { credits: 200 } }),
      session({ usage: {} }),
    ])).toBe(150);
  });

  test('average is null when nothing is known', () => {
    expect(averageCredits([])).toBeNull();
    expect(averageCredits([session({ usage: {} })])).toBeNull();
  });
});

describe('templateBreakdown', () => {
  test('sorts by spend and computes each share', () => {
    const out = templateBreakdown(
      [
        { template_id: 'tmpl_a', credits: 250, session_count: 3 },
        { template_id: 'tmpl_b', credits: 750, session_count: 9 },
      ],
      new Map([['tmpl_b', '干活小能手']]),
    );
    expect(out[0].templateId).toBe('tmpl_b');
    expect(out[0].name).toBe('干活小能手');
    expect(out[0].share).toBeCloseTo(0.75);
    expect(out[1].share).toBeCloseTo(0.25);
  });

  test('falls back to the id when no name is known', () => {
    const out = templateBreakdown([{ template_id: 'tmpl_zz', credits: 1, session_count: 1 }]);
    expect(out[0].name).toBe('tmpl_zz');
  });

  test('null credits sort last and claim no share', () => {
    const out = templateBreakdown([
      { template_id: 'tmpl_null', credits: null, session_count: 2 },
      { template_id: 'tmpl_real', credits: 5, session_count: 1 },
    ]);
    expect(out[0].templateId).toBe('tmpl_real');
    expect(out[1].share).toBe(0);
  });

  test('an all-zero window does not divide by zero', () => {
    const out = templateBreakdown([{ template_id: 't', credits: 0, session_count: 1 }]);
    expect(out[0].share).toBe(0);
  });
});

describe('dayLabel', () => {
  test('renders a compact axis label', () => {
    expect(dayLabel('2026-08-11')).toBe('8-11');
    expect(dayLabel('2026-08-01')).toBe('8-1');
  });
});
