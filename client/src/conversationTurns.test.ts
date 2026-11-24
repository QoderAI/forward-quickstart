import { describe, expect, test } from 'vitest';
import type { ForwardEvent } from './forwardApi';
import { commitConversationTurn, conversationCredits, latestTurnState, mergeConversationEvents, projectConversation, toolSummary } from './conversationTurns';

function event(id: string, type: string, extra: Partial<ForwardEvent> = {}): ForwardEvent {
  return { id, type, session_id: 'session', ...extra };
}

function at(seconds: number) {
  return { created_at: new Date(seconds * 1000).toISOString() };
}

function idle(id: string, type: string, seconds: number, eventIds: string[] = []) {
  return event(id, 'session.status_idle', { ...at(seconds), stop_reason: { type, event_ids: eventIds } });
}

describe('conversation projection', () => {
  test('keeps a pause, continuation, and child completion inside the same turn', () => {
    const events = [
      event('u1', 'user.message'),
      event('running', 'session.status_running', at(1)),
      event('narration', 'agent.message', { content: 'I will inspect it.' }),
      event('tool', 'agent.tool_use', { name: 'Read' }),
      event('child', 'session.thread_status_idle', at(2)),
      idle('wait', 'requires_action', 3, ['tool']),
    ];
    const [waiting] = projectConversation(events, false);
    expect(waiting).toMatchObject({ key: 'u1', state: 'waiting', elapsedMs: 2000, answers: [] });
    expect(waiting.tools[0].state).toBe('waiting');
    const done = projectConversation([
      ...events,
      event('confirm', 'user.tool_confirmation', { tool_use_id: 'tool', result: 'allow' }),
      event('resume', 'session.status_running', at(33)),
      event('result', 'agent.tool_result', { tool_use_id: 'tool' }),
      event('answer', 'agent.message', { content: 'Result' }),
      event('artifact', 'agent.artifact_delivered', { file_id: 'file_1' }),
      idle('done', 'end_turn', 37),
    ], false);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ state: 'done', elapsedMs: 6000, answers: [{ id: 'answer' }], tools: [{ state: 'done' }] });
    expect(done[0].steps.map(step => step.kind)).toEqual(['narration', 'tool', 'coordination']);
    expect(done[0].events.some(item => item.file_id === 'file_1')).toBe(true);
  });

  test('pairs same-name and cross-family tools only with their own reference', () => {
    const [turn] = projectConversation([
      event('user', 'user.message'),
      event('tool-b', 'agent.tool_use', { name: 'Read' }),
      event('tool-a', 'agent.tool_use', { name: 'Read' }),
      event('mcp', 'agent.mcp_tool_use', { name: 'Read' }),
      event('custom', 'agent.custom_tool_use', { name: 'Read' }),
      event('custom-result', 'user.custom_tool_result', { custom_tool_use_id: 'custom' }),
      event('denied', 'user.tool_confirmation', { tool_use_id: 'tool-b', result: 'deny' }),
      event('mcp-result', 'agent.mcp_tool_result', { mcp_tool_use_id: 'mcp', is_error: true }),
      event('builtin-result', 'agent.tool_result', { tool_use_id: 'tool-a' }),
      idle('done', 'end_turn', 5),
    ], false);
    expect(turn.state).toBe('done');
    expect(turn.tools.map(step => [step.event.id, step.result?.id, step.state])).toEqual([
      ['tool-b', undefined, 'denied'], ['tool-a', 'builtin-result', 'done'],
      ['mcp', 'mcp-result', 'failed'], ['custom', 'custom-result', 'done'],
    ]);
  });

  test('leaves a partial history turn separate and reconciles it when loading older events', () => {
    const tail = [event('a1', 'agent.message'), idle('d1', 'end_turn', 1), event('u2', 'user.message'), event('a2', 'agent.message')];
    const partial = projectConversation(tail, true);
    expect(partial[0]).toMatchObject({ partial: true, answers: [{ id: 'a1' }] });
    expect(partial[1]).toMatchObject({ key: 'u2', answers: [{ id: 'a2' }] });
    const full = projectConversation(mergeConversationEvents(tail, [event('u1', 'user.message'), tail[0]], 'older'), false);
    expect(full.map(turn => turn.key)).toEqual(['u1', 'u2']);
    expect(full[0].partial).toBe(false);
    expect(full[0].elapsedMs).toBeUndefined();
  });

  test('does not suppress equal answers in separate turns or discard an interrupted draft', () => {
    const entries = [
      event('u1', 'user.message'), event('a1', 'agent.message', { content: 'Same' }), idle('d1', 'end_turn', 1),
      event('u2', 'user.message'), event('local-stream-a2', 'agent.message', { content: 'Same', stream_event_id: 'a2' }),
      event('e2', 'session.error'),
    ];
    const [first, second] = projectConversation(entries, false);
    expect(first.answers[0].content).toBe('Same');
    expect(second).toMatchObject({ state: 'failed', answers: [{ content: 'Same' }], errors: [{ id: 'e2' }] });
    expect(projectConversation(entries.slice(3, 5).concat(event('stop', 'local.stop_confirmed')), false)[0]).toMatchObject({ state: 'stopped', answers: [{ content: 'Same' }] });
  });
});

describe('reconciling transport and history', () => {
  test('uses the exact POST user ID while preserving the optimistic key', () => {
    const earlier = event('earlier', 'user.message', { content: 'Repeat' });
    const optimistic = event('local-user', 'user.message', { content: 'Repeat' });
    const accepted = event('remote-user', 'user.message', { content: 'Repeat' });
    for (const current of [[earlier, optimistic], [earlier, optimistic, accepted]]) {
      const result = commitConversationTurn(current, optimistic.id, [accepted]);
      expect(result.map(item => item.id)).toEqual(['earlier', 'remote-user']);
      expect(projectConversation(result, false).map(turn => turn.key)).toEqual(['earlier', 'local-user']);
    }
  });

  test('places late terminal history before a new local user and repairs an already misordered overlap', () => {
    const u1 = event('u1', 'user.message');
    const a1 = event('a1', 'agent.message');
    const done = idle('done1', 'end_turn', 3);
    const u2 = event('local-u2', 'user.message');
    const local = mergeConversationEvents([u1, a1, u2], [u1, a1, done], 'history');
    expect(local.map(item => item.id)).toEqual(['u1', 'a1', 'done1', 'local-u2']);
    expect(projectConversation(local, false).map(turn => turn.state)).toEqual(['done', 'pending']);
    const u2Remote = event('u2', 'user.message');
    const fixed = mergeConversationEvents([u1, a1, u2Remote, done], [u1, a1, done, u2Remote], 'history');
    expect(fixed.map(item => item.id)).toEqual(['u1', 'a1', 'done1', 'u2']);
  });

  test('polling needs a pause or terminal signal after the confirmed turn anchor', () => {
    const previous = idle('done1', 'end_turn', 2);
    const user = event('u2', 'user.message', at(3));
    const active = event('running2', 'session.status_running', at(4));
    const child = event('child2', 'session.thread_status_idle', at(5));
    expect(latestTurnState([previous, user, active, child], user.id)).toBe('running');
    expect(latestTurnState([previous], user.id, at(3).created_at)).toBeUndefined();
    expect(latestTurnState([previous, user, active, idle('wait2', 'requires_action', 6)], user.id)).toBe('waiting');
  });

  test('keeps unpublished text before replayed terminal history', () => {
    const user = event('u', 'user.message');
    const draft = event('local-stream-a', 'agent.message', { stream_event_id: 'a', content: 'partial' });
    const end = event('e', 'session.canceled');
    const result = mergeConversationEvents([user, draft], [user, end], 'history');
    expect(result.map(item => item.id)).toEqual(['u', 'local-stream-a', 'e']);
    expect(projectConversation(result, false)[0]).toMatchObject({ state: 'stopped', answers: [{ content: 'partial' }] });
  });

  test('canonical events replace drafts at their positions and do not duplicate them', () => {
    const user = event('u', 'user.message');
    const draft = event('local-stream-answer', 'agent.message', { stream_event_id: 'answer', content: 'partial' });
    const end = idle('end', 'end_turn', 6);
    const answer = event('answer', 'agent.message', { content: 'entire' });
    const result = mergeConversationEvents([user, draft, end], [answer]);
    expect(result.map(item => item.id)).toEqual(['u', 'answer', 'end']);
    expect(result[1].content).toBe('entire');
    expect(mergeConversationEvents(result, [user, answer, end])).toEqual(result);
  });

  test('does not erase received thinking when the canonical record has no text', () => {
    const draft = event('local-stream-thinking', 'agent.thinking', { stream_event_id: 'thinking', content: 'shown' });
    const canonical = event('thinking', 'agent.thinking', { content: [] });
    const live = mergeConversationEvents([draft], [canonical]);
    expect(live).toEqual([{ ...canonical, content: 'shown' }]);
    expect(mergeConversationEvents(live, [canonical], 'history')).toEqual(live);
  });

  test('cumulative credit supports a top-level zero and a newer GET snapshot', () => {
    const usage = [
      event('legacy', 'session.usage', { ...at(1), usage: { total_credits: 9 } }),
      event('current', 'session.usage', { ...at(2), total_credits: 0 }),
      event('invalid', 'session.usage', { ...at(3), total_credits: -1 }),
    ];
    expect(conversationCredits(usage)).toBe(0);
    expect(conversationCredits(usage, { usage: { total_credits: 7 }, updated_at: at(4).created_at })).toBe(7);
    expect(conversationCredits([], { usage: { total_credits: 0 } })).toBe(0);
  });

  test('summarizes only safe fields and strips link credentials and tokens', () => {
    expect(toolSummary('WebFetch', { url: 'https://demo:secret@example.com/api?token=private' })).toBe('example.com');
    expect(toolSummary('Read', { path: '/root/private/doc.md', token: 'secret' })).toBe('doc.md');
    expect(toolSummary('Bash', { command: 'do not render' })).toBe('');
  });
});
