import { afterEach, describe, expect, test, vi } from 'vitest';
import { listEvents, type ForwardContext } from './forwardApi';

describe('listEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('passes event type filters using the supported types query parameter', async () => {
    let requestBody: any;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [], has_more: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const ctx: ForwardContext = { pat: 'pat_test', environment: 'cn-pre' };
    await listEvents(ctx, 'sess_123');

    expect(requestBody.query).toEqual({
      limit: 100,
      order: 'desc',
      types: [
        'user.message',
        'agent.message',
        'agent.thinking',
        'agent.tool_use',
        'agent.custom_tool_use',
        'agent.mcp_tool_use',
        'agent.tool_result',
        'agent.custom_tool_result',
        'agent.mcp_tool_result',
      ].join(','),
    });
    expect(requestBody.query).not.toHaveProperty('types[]');
  });
});
