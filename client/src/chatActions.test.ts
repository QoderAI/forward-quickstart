import { describe, expect, test } from 'vitest';
import {
  derivePendingQuestion,
  derivePendingToolApprovals,
  encodeQuestionAnswers,
} from './chatActions';
import type { ForwardEvent } from './forwardApi';

function event(id: string, type: string, extra: Record<string, unknown> = {}): ForwardEvent {
  return { id, type, session_id: 'sess_1', ...extra };
}

describe('derivePendingToolApprovals', () => {
  test('returns only ask-policy tool uses referenced by requires_action', () => {
    const events = [
      event('tool_ask', 'agent.tool_use', { name: 'Bash', input: { command: 'pwd' }, evaluated_permission: 'ask' }),
      event('tool_allow', 'agent.tool_use', { name: 'Read', evaluated_permission: 'allow' }),
      event('idle', 'session.status_idle', { stop_reason: { type: 'requires_action', event_ids: ['tool_ask', 'tool_allow'] } }),
    ];
    expect(derivePendingToolApprovals(events)).toEqual([
      { toolUseId: 'tool_ask', toolName: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  test('removes an approval after a confirmation event arrives', () => {
    const events = [
      event('tool_1', 'agent.tool_use', { name: 'Edit', evaluated_permission: 'ask' }),
      event('idle', 'session.status_idle', { stop_reason: { type: 'requires_action', event_ids: ['tool_1'] } }),
      event('confirm', 'user.tool_confirmation', { tool_use_id: 'tool_1', result: 'deny' }),
    ];
    expect(derivePendingToolApprovals(events)).toEqual([]);
  });
});

describe('derivePendingQuestion', () => {
  const questions = [{
    question: '选择环境？',
    header: '环境',
    options: [{ label: '测试', description: '测试环境' }, { label: '生产' }],
    multiSelect: false,
  }];

  test('parses a built-in question and clears it after answer', () => {
    const ask = event('ask_1', 'agent.ask_user_question', { questions });
    expect(derivePendingQuestion([ask])?.questions).toEqual(questions);
    expect(derivePendingQuestion([
      ask,
      event('answer', 'user.question_answer', { question_use_id: 'ask_1', answers: [['测试']] }),
    ])).toBeNull();
  });

  test('supports the recognized custom-tool question path', () => {
    const ask = event('ask_custom', 'agent.custom_tool_use', { name: 'AskUserQuestion', input: { questions } });
    expect(derivePendingQuestion([ask])?.viaCustomTool).toBe(true);
    expect(derivePendingQuestion([
      ask,
      event('result', 'user.custom_tool_result', { custom_tool_use_id: 'ask_custom' }),
    ])).toBeNull();
  });

  test('clears a question when its turn ends without an answer', () => {
    const ask = event('ask_ended', 'agent.ask_user_question', { turn_id: 'turn_1', questions });
    expect(derivePendingQuestion([
      ask,
      event('idle', 'session.status_idle', {
        turn_id: 'turn_1',
        stop_reason: { type: 'cancelled' },
      }),
    ])).toBeNull();
  });

  test('encodes custom-tool answers for the model', () => {
    expect(encodeQuestionAnswers(questions, [['测试']])).toContain('"选择环境？"="测试"');
  });
});
