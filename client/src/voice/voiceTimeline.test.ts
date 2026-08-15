import { describe, expect, test } from 'vitest';
import { applyVoiceTimelineEvent, createVoiceTimelineState, projectVoiceHistory, selectTimelineEntries, upsertLocalUserTextDraft } from './voiceTimeline';

function transcript(type: 'transcript.delta' | 'transcript.final', eventId: string, text: string, itemId = 'item-1') {
  return {
    version: 'voice.realtime.v1', type, event_id: eventId, sequence: 1,
    conversation_id: 'conv_1', timestamp: '2026-08-15T00:00:00Z',
    payload: { role: 'user' as const, text, item_id: itemId },
  };
}

describe('voice timeline', () => {
  test('projects history into captions and one work card', () => {
    const events = [
      { id: 'done', type: 'voice.work.completed', status: 'completed', work_id: 'work_1', result: '完成', occurred_at: '2026-01-01T00:00:03Z' },
      { id: 'msg', type: 'voice.user_message.completed', status: 'completed', role: 'user' as const, text: '查一下', turn_id: 'turn_1', occurred_at: '2026-01-01T00:00:01Z' },
      { id: 'run', type: 'voice.work.running', status: 'running', work_id: 'work_1', objective: '查资料', turn_id: 'turn_1', occurred_at: '2026-01-01T00:00:02Z' },
    ];
    const result = projectVoiceHistory(events);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ kind: 'work', workId: 'work_1', objective: '查资料', status: 'completed', result: '完成' });
  });
  test('updates live work in place and does not regress terminal state', () => {
    let state = createVoiceTimelineState();
    const event = (type: string, sequence: number, payload: Record<string, unknown> = {}) => ({ version: 'voice.realtime.v1', type, event_id: `evt_${sequence}`, sequence, conversation_id: 'conv_1', timestamp: '', work_id: 'work_1', payload });
    state = applyVoiceTimelineEvent(state, event('work.running', 1, { objective: '查资料' }));
    state = applyVoiceTimelineEvent(state, event('work.completed', 2, { result: '完成' }));
    state = applyVoiceTimelineEvent(state, event('work.progress', 3, { detail: '迟到' }));
    expect(selectTimelineEntries(state)).toEqual([{ kind: 'work', id: 'work_1', workId: 'work_1', objective: '查资料', status: 'completed', steps: [], result: '完成' }]);
  });

  test('reconciles the gateway echo with the optimistic user bubble', () => {
    let state = upsertLocalUserTextDraft(createVoiceTimelineState(), 'local-1', '帮我看看有哪些文件 ...', false);
    state = applyVoiceTimelineEvent(state, {
      version: 'voice.realtime.v1',
      type: 'transcript.final',
      event_id: 'server-1',
      sequence: 1,
      conversation_id: 'conv_1',
      timestamp: '2026-08-15T00:00:00Z',
      payload: { role: 'user', text: '帮我看看有哪些文件' },
    });

    expect(selectTimelineEntries(state)).toEqual([
      { kind: 'caption', id: 'local-1', role: 'user', text: '帮我看看有哪些文件', pending: false },
    ]);
  });

  test('keeps one stream bubble and ignores events after its final', () => {
    const event = (type: string, eventId: string, text: string) => ({
      version: 'voice.realtime.v1', type, event_id: eventId, sequence: 1,
      conversation_id: 'conv_1', timestamp: '2026-08-15T00:00:00Z',
      payload: { role: 'assistant', text, response_id: 'response-1' },
    });
    let state = createVoiceTimelineState();
    state = applyVoiceTimelineEvent(state, event('transcript.delta', 'delta-1', '北'));
    state = applyVoiceTimelineEvent(state, event('transcript.delta', 'delta-2', '京'));
    state = applyVoiceTimelineEvent(state, event('transcript.final', 'final-1', '北京'));
    state = applyVoiceTimelineEvent(state, event('transcript.delta', 'late-1', '迟到内容'));

    expect(selectTimelineEntries(state)).toEqual([
      { kind: 'caption', id: 'delta-1', role: 'assistant', text: '北京', pending: false },
    ]);
  });

  test('replaces user transcript snapshots instead of concatenating them', () => {
    let state = createVoiceTimelineState();
    state = applyVoiceTimelineEvent(state, transcript('transcript.delta', 'delta-1', '帮我去 GitHub'));
    state = applyVoiceTimelineEvent(state, transcript('transcript.delta', 'delta-2', '帮我去 GitHub 上查询 agent sdk'));
    state = applyVoiceTimelineEvent(state, transcript('transcript.delta', 'delta-3', '帮我去 GitHub 上查询 agent sdk，然后下载'));

    expect(selectTimelineEntries(state)).toEqual([
      { kind: 'caption', id: 'delta-1', role: 'user', text: '帮我去 GitHub 上查询 agent sdk，然后下载', pending: true },
    ]);
  });

  test.each([
    {
      name: 'keeps the richer snapshot when smart-turn final is only a punctuated prefix',
      delta: '请查询一下杭州的天气。',
      final: '请查询一下杭州的。',
      expected: '请查询一下杭州的天气。',
    },
    {
      name: 'uses a substantially corrected ASR final',
      delta: '在GitHub上搜索ent Bay 满到码下载到沙响本地。',
      final: '在GitHub上搜索 agentbase/sdk，并下载到沙箱本地。',
      expected: '在GitHub上搜索 agentbase/sdk，并下载到沙箱本地。',
    },
  ])('$name', ({ delta, final, expected }) => {
    let state = createVoiceTimelineState();
    state = applyVoiceTimelineEvent(state, transcript('transcript.delta', 'delta-1', delta));
    state = applyVoiceTimelineEvent(state, transcript('transcript.final', 'final-1', final));

    expect(selectTimelineEntries(state)).toEqual([
      { kind: 'caption', id: 'delta-1', role: 'user', text: expected, pending: false },
    ]);
  });
});
