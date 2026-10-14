import { afterEach, describe, expect, test, vi } from 'vitest';
import { listIdentityUsage, listTemplateUsage, listSessionsPage, uploadCloudFile, type ForwardContext } from './forwardApi';

const ctx: ForwardContext = { pat: 'forward_sat', authMode: 'service-account', environment: 'global-prod' };
const window = { startMs: Date.parse('2026-10-01T00:00:00+08:00'), endMs: Date.parse('2026-10-02T00:00:00+08:00') };
afterEach(() => vi.unstubAllGlobals());

describe('hourly Usage API', () => {
  test('loads all pages with a stable Shanghai window and preserves fractional/unknown values', async () => {
    const requests: Array<{ query: Record<string, unknown>; authMode: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json(requests.length === 1
        ? { data: [{ template_id: 't1', active_seconds: 0.125, credits: null }], has_more: true, last_id: 'next' }
        : { data: [{ template_id: 't2', active_seconds: 10.5 }], has_more: false });
    }));
    const page = await listTemplateUsage(ctx, { ...window, identityId: 'i1', templateId: 't1' });
    expect(page.data).toEqual([{ template_id: 't1', active_seconds: 0.125, credits: null }, { template_id: 't2', active_seconds: 10.5, credits: null }]);
    expect(requests[0]).toMatchObject({ authMode: 'service-account', query: {
      start_at: '2026-10-01T00:00:00', end_at: '2026-10-02T00:00:00', identity_ids: ['i1'], template_ids: ['t1'], limit: 100,
    } });
    expect(requests[1].query).toEqual({ ...requests[0].query, after_id: 'next' });
    expect(page.has_more).toBe(false);
  });
  test('empty month-to-date window sends no invalid API request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await listIdentityUsage(ctx, { startMs: window.startMs, endMs: window.startMs })).data).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('rejects missing or repeating cursors instead of silently returning partial totals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [], has_more: true, last_id: 'stuck' })));
    await expect(listIdentityUsage(ctx, window)).rejects.toThrow('分页游标');
  });
  test('rejects incomplete-hour and over-wide ranges', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(listIdentityUsage(ctx, { ...window, startMs: window.startMs + 1 })).rejects.toThrow('整点');
    await expect(listIdentityUsage(ctx, { ...window, endMs: window.startMs + 745 * 3_600_000 })).rejects.toThrow('744');
    expect(fetch).not.toHaveBeenCalled();
  });
  test('ledger sends an exclusive upper timestamp boundary', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [], has_more: false })); vi.stubGlobal('fetch', fetch);
    await listSessionsPage(ctx, { createdAtGte: new Date(window.startMs).toISOString(), createdAtLt: new Date(window.endMs).toISOString() });
    const call = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(call.query['created_at[lt]']).toBe(new Date(window.endMs).toISOString());
    expect(call.query).not.toHaveProperty('created_at[lte]');
  });
});

test('file multipart carries SAT mode without putting it in file metadata', async () => {
  let form: FormData | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { form = init.body; return Response.json({ id: 'f1' }); }));
  await uploadCloudFile(ctx, { file: new File(['hello'], 'hello.txt'), metadata: { source: 'chat' }, purpose: 'session_resource' });
  expect(form?.get('authMode')).toBe('service-account');
  expect(JSON.parse(String(form?.get('metadata')))).toEqual({ source: 'chat' });
});
