import { describe, expect, it } from 'vitest';
import type { ForwardEvent, ForwardTemplate } from './forwardApi';
import { buildMultiagentView, coordinatorConfig, eventPlainText } from './multiagent';

const ev = (id: string, type: string, extra: Record<string, unknown> = {}): ForwardEvent =>
  ({ id, type, session_id: 'sess_1', ...extra }) as ForwardEvent;

describe('coordinatorConfig', () => {
  it('识别协调者模板', () => {
    const template = {
      id: 'tmpl_1',
      name: '专家团-责任编辑',
      status: 'active',
      model: 'qmodel_38max',
      multiagent: { type: 'coordinator', agents: [{ type: 'agent', name: '选题策划' }] },
    } as unknown as ForwardTemplate;
    expect(coordinatorConfig(template)?.agents).toHaveLength(1);
  });

  it('非 multiagent 模板返回 null', () => {
    const template = { id: 'tmpl_2', name: '中学物理老师助手', status: 'active', model: 'm', multiagent: null } as unknown as ForwardTemplate;
    expect(coordinatorConfig(template)).toBeNull();
    expect(coordinatorConfig(undefined)).toBeNull();
  });
});

describe('buildMultiagentView', () => {
  const events: ForwardEvent[] = [
    ev('e1', 'session.thread_created', { session_thread_id: 'sthr_a' }),
    ev('e2', 'agent.thread_message_sent', {
      to_session_thread_id: 'sthr_a',
      to_template_name: '专家团-选题策划',
      content: [{ type: 'text', text: '请给出选题策划案' }],
      processed_at: '2026-11-02T09:21:20Z',
    }),
    ev('e3', 'session.thread_status_running', { session_thread_id: 'sthr_a' }),
    ev('e4', 'agent.thread_message_received', {
      from_session_thread_id: 'sthr_a',
      from_template_name: '专家团-选题策划',
      content: [{ type: 'text', text: '策划案正文……' }],
      processed_at: '2026-11-02T09:32:48Z',
    }),
    ev('e5', 'session.thread_status_idle', { session_thread_id: 'sthr_a', stop_reason: 'end_turn' }),
    ev('e6', 'agent.message', { content: [{ type: 'text', text: '普通消息不应进入账本' }] }),
  ];

  it('按子 Agent 聚合派发与回执', () => {
    const view = buildMultiagentView(events);
    expect(view.active).toBe(true);
    expect(view.threads).toHaveLength(1);
    const thread = view.threads[0];
    expect(thread.name).toBe('专家团-选题策划');
    expect(thread.status).toBe('idle');
    expect(thread.stopReason).toBe('end_turn');
    expect(thread.dispatches.map((d) => d.text)).toEqual(['请给出选题策划案']);
    expect(thread.replies.map((r) => r.text)).toEqual(['策划案正文……']);
  });

  it('为每类事件标注渲染角色，普通消息无角色', () => {
    const view = buildMultiagentView(events);
    expect(view.roles.e1).toMatchObject({ role: 'status', status: 'created' });
    expect(view.roles.e2).toMatchObject({ role: 'dispatch', name: '专家团-选题策划' });
    expect(view.roles.e3).toMatchObject({ role: 'status', status: 'running' });
    expect(view.roles.e4).toMatchObject({ role: 'reply', name: '专家团-选题策划' });
    expect(view.roles.e5).toMatchObject({ role: 'status', status: 'idle' });
    expect(view.roles.e6).toBeUndefined();
  });

  it('thread_created 的名字在拿到真实模板名后回填', () => {
    const view = buildMultiagentView(events);
    expect(view.roles.e1).toMatchObject({ role: 'status', status: 'created', name: '专家团-选题策划' });
  });

  it('始终拿不到名字时保留占位名', () => {
    const view = buildMultiagentView([ev('x1', 'session.thread_created', { session_thread_id: 'sthr_zz9abc' })]);
    expect(view.roles.x1).toMatchObject({ name: '子线程 zz9abc' });
  });

  it('协调者自己的主线程不算子 Agent，并显示为协调者名字', () => {
    const view = buildMultiagentView(
      [
        ev('c1', 'session.thread_status_running', { session_thread_id: 'sthr_main' }),
        ev('c2', 'session.thread_status_idle', { session_thread_id: 'sthr_main', stop_reason: 'end_turn' }),
        ...events,
      ],
      '专家团-责任编辑',
    );
    const main = view.threads.find((t) => t.id === 'sthr_main');
    expect(main?.isCoordinator).toBe(true);
    expect(main?.name).toBe('专家团-责任编辑');
    expect(view.roles.c1).toMatchObject({ name: '专家团-责任编辑', status: 'running' });
    expect(view.threads.filter((t) => !t.isCoordinator).map((t) => t.name)).toEqual(['专家团-选题策划']);
    expect(view.active).toBe(true);
  });

  it('动态 create_agent 拉起的子线程，从工具调用里还原子 Agent 名字', () => {
    const view = buildMultiagentView([
      ev('t1', 'agent.tool_use', { name: 'create_agent', input: { name: '专家团-选题策划', task: '给一个选题' } }),
      ev('t2', 'agent.tool_result', {
        tool_use_id: 't1',
        content: [{ type: 'text', text: 'Created agent thread: sthr_00uagb56s43r42x22gw4' }],
      }),
      ev('t3', 'session.thread_created', { session_thread_id: 'sthr_00uagb56s43r42x22gw4' }),
      ev('t4', 'agent.thread_message_sent', { to_session_thread_id: 'sthr_00uagb56s43r42x22gw4', content: '给一个选题' }),
      ev('t5', 'agent.thread_message_received', {
        from_session_thread_id: 'sthr_00uagb56s43r42x22gw4',
        content: '选题：……',
      }),
    ]);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0].name).toBe('专家团-选题策划');
    expect(view.threads[0].isCoordinator).toBe(false);
    expect(view.roles.t3).toMatchObject({ name: '专家团-选题策划', status: 'created' });
    expect(view.roles.t4).toMatchObject({ role: 'dispatch', name: '专家团-选题策划' });
    expect(view.roles.t5).toMatchObject({ role: 'reply', name: '专家团-选题策划' });
  });

  it('thread_status_rescheduled 标记为排队重试且不算已完成', () => {
    const view = buildMultiagentView([
      ev('r1', 'session.thread_created', { session_thread_id: 'sthr_r' }),
      ev('r2', 'agent.thread_message_sent', { to_session_thread_id: 'sthr_r', to_template_name: '专家团-文案编辑', content: '写一段' }),
      ev('r3', 'session.thread_status_rescheduled', { session_thread_id: 'sthr_r' }),
    ]);
    expect(view.roles.r3).toMatchObject({ role: 'status', status: 'rescheduled', name: '专家团-文案编辑' });
    expect(view.threads[0].status).toBe('rescheduled');
  });

  it('无 thread 事件时视图为空（普通单 Agent 会话）', () => {
    const view = buildMultiagentView([events[5]]);
    expect(view.active).toBe(false);
    expect(view.threads).toHaveLength(0);
  });
});

describe('eventPlainText', () => {
  it('支持字符串 / 对象 / 数组三种 content 形态', () => {
    expect(eventPlainText(ev('a', 't', { content: 'plain' }))).toBe('plain');
    expect(eventPlainText(ev('b', 't', { content: { type: 'text', text: 'obj' } }))).toBe('obj');
    expect(eventPlainText(ev('c', 't', { content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] }))).toBe('xy');
  });
});
