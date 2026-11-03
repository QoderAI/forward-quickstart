import type { ForwardEvent, ForwardTemplate, MultiagentConfig } from './forwardApi';

// ─── Multi Agent 协同事件的解析与状态聚合 ───
// 协调者（coordinator）模板发起的会话里，父事件流会额外暴露 6 类 thread 事件：
//   session.thread_created / thread_status_running / thread_status_idle /
//   thread_status_rescheduled（带 session_thread_id，标识某条子线程的状态）
//   agent.thread_message_sent（带 to_session_thread_id + to_template_name，协调者派发任务）
//   agent.thread_message_received（带 from_session_thread_id + from_template_name，子 Agent 回执）
// 派发/回执事件自带子 Agent 的模板名，因此可以直接把每条消息归属到具体子 Agent，
// 在对话界面里还原出「协调者 ↔ 子 Agent」的一对多协同过程。

export const MULTIAGENT_EVENT_TYPES = new Set([
  'session.thread_created',
  'session.thread_status_running',
  'session.thread_status_idle',
  'session.thread_status_rescheduled',
  'agent.thread_message_sent',
  'agent.thread_message_received',
]);

export type MultiagentThreadStatus = 'created' | 'running' | 'idle' | 'rescheduled' | 'unknown';

export interface MultiagentMessage {
  id: string;
  text: string;
  at?: string;
}

export interface MultiagentThread {
  id: string;
  name: string;
  status: MultiagentThreadStatus;
  stopReason?: string;
  dispatches: MultiagentMessage[];
  replies: MultiagentMessage[];
  /** 协调者自己的主线程（没有 thread_created、也不收发消息），不属于「子 Agent」。 */
  isCoordinator?: boolean;
}

export type MultiagentEventRole =
  | { role: 'dispatch'; threadId: string; name: string; text: string }
  | { role: 'reply'; threadId: string; name: string; text: string }
  | { role: 'status'; threadId: string; name: string; status: MultiagentThreadStatus; stopReason?: string };

export interface MultiagentView {
  threads: MultiagentThread[];
  roles: Record<string, MultiagentEventRole>;
  active: boolean;
}

/** 非协调者模板用空视图：thread 事件不渲染任何协同 UI，保持单 Agent 的原有对话形态。 */
export const EMPTY_MULTIAGENT_VIEW: MultiagentView = { threads: [], roles: {}, active: false };

export function isMultiagentEvent(event: ForwardEvent): boolean {
  return MULTIAGENT_EVENT_TYPES.has(event.type);
}

/** 模板是否配置为 multiagent 协调者；非协调者返回 null（对话保持普通单 Agent 形态）。 */
export function coordinatorConfig(template?: ForwardTemplate | null): MultiagentConfig | null {
  const config = template?.multiagent;
  return config && config.type === 'coordinator' ? config : null;
}

export function eventPlainText(event: ForwardEvent): string {
  const content = event.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function field(event: ForwardEvent, key: string): string {
  const value = event[key];
  return typeof value === 'string' && value ? value : '';
}

function placeholderName(threadId: string): string {
  return `子线程 ${threadId.slice(-6)}`;
}

// 协调者用 create_agent 动态拉起的子 Agent，thread_message_sent/received 里不带
// to_template_name / from_template_name（只有花名册模板派发才带）。此时子 Agent 的名字
// 只能从工具调用里还原：tool_use(create_agent).input.name → tool_result 文本
// “Created agent thread: sthr_xxx”，用 tool_use_id 关联出 thread → 名字。
const CREATED_THREAD_RE = /Created agent thread:\s*(sthr_[0-9a-z]+)/i;

/** 把父事件流里的 thread 事件聚合成「子 Agent 线程账本」+ 每个事件的渲染角色。 */
export function buildMultiagentView(events: ForwardEvent[], coordinatorName = '协调者'): MultiagentView {
  const threads: MultiagentThread[] = [];
  const byId = new Map<string, MultiagentThread>();
  const roles: Record<string, MultiagentEventRole> = {};
  const createdThreads = new Set<string>();
  const pendingAgentNames = new Map<string, string>();
  const threadNames = new Map<string, string>();

  const ensure = (threadId: string, name?: string): MultiagentThread => {
    let thread = byId.get(threadId);
    if (!thread) {
      thread = { id: threadId, name: name || placeholderName(threadId), status: 'unknown', dispatches: [], replies: [] };
      byId.set(threadId, thread);
      threads.push(thread);
    } else if (name && thread.name.startsWith('子线程 ')) {
      thread.name = name;
    }
    return thread;
  };

  for (const event of events) {
    if (event.type === 'agent.tool_use') {
      const tool = field(event, 'name') || field(event, 'tool_name');
      const input = event.input as { name?: unknown } | undefined;
      if (tool === 'create_agent' && typeof input?.name === 'string' && input.name) {
        pendingAgentNames.set(event.id, input.name);
      }
      continue;
    }

    if (event.type === 'agent.tool_result') {
      const name = pendingAgentNames.get(field(event, 'tool_use_id'));
      if (name) {
        const matched = CREATED_THREAD_RE.exec(eventPlainText(event));
        if (matched) threadNames.set(matched[1], name);
      }
      continue;
    }

    if (!MULTIAGENT_EVENT_TYPES.has(event.type)) continue;

    if (event.type === 'session.thread_created') {
      const threadId = field(event, 'session_thread_id');
      if (!threadId) continue;
      const thread = ensure(threadId);
      createdThreads.add(threadId);
      if (thread.status === 'unknown') thread.status = 'created';
      roles[event.id] = { role: 'status', threadId, name: thread.name, status: 'created' };
      continue;
    }

    if (
      event.type === 'session.thread_status_running' ||
      event.type === 'session.thread_status_idle' ||
      event.type === 'session.thread_status_rescheduled'
    ) {
      const threadId = field(event, 'session_thread_id');
      if (!threadId) continue;
      const status: MultiagentThreadStatus =
        event.type === 'session.thread_status_running' ? 'running'
        : event.type === 'session.thread_status_idle' ? 'idle'
        : 'rescheduled';
      const thread = ensure(threadId);
      thread.status = status;
      if (status === 'idle') {
        const stopReason = field(event, 'stop_reason');
        if (stopReason) thread.stopReason = stopReason;
      }
      roles[event.id] = { role: 'status', threadId, name: thread.name, status, stopReason: thread.stopReason };
      continue;
    }

    if (event.type === 'agent.thread_message_sent') {
      const threadId = field(event, 'to_session_thread_id');
      const name = field(event, 'to_template_name');
      const text = eventPlainText(event);
      const thread = threadId ? ensure(threadId, name) : undefined;
      if (thread) thread.dispatches.push({ id: event.id, text, at: event.processed_at });
      roles[event.id] = { role: 'dispatch', threadId, name: name || thread?.name || '子 Agent', text };
      continue;
    }

    if (event.type === 'agent.thread_message_received') {
      const threadId = field(event, 'from_session_thread_id');
      const name = field(event, 'from_template_name');
      const text = eventPlainText(event);
      const thread = threadId ? ensure(threadId, name) : undefined;
      if (thread) thread.replies.push({ id: event.id, text, at: event.processed_at });
      roles[event.id] = { role: 'reply', threadId, name: name || thread?.name || '子 Agent', text };
    }
  }

  // 协调者自己的主线程也会发 running/idle 状态，但它既没有 thread_created、也不收发消息，
  // 不能当成子 Agent 展示，否则花名册会多出一个「子线程 xxxxxx」。
  for (const thread of threads) {
    const recovered = threadNames.get(thread.id);
    if (recovered && thread.name.startsWith('子线程 ')) thread.name = recovered;
    thread.isCoordinator =
      !createdThreads.has(thread.id) && thread.dispatches.length === 0 && thread.replies.length === 0;
    if (thread.isCoordinator) thread.name = coordinatorName;
  }

  // thread_created 早于任何消息事件，此刻还不知道子 Agent 名字；等真实名字到位后回填，
  // 避免同一个子线程在时间线上一会儿叫“子线程 xxxxxx”、一会儿叫真名。
  for (const role of Object.values(roles)) {
    const thread = byId.get(role.threadId);
    if (!thread) continue;
    if (thread.isCoordinator || role.name.startsWith('子线程 ') || role.name === '子 Agent') role.name = thread.name;
  }

  return { threads, roles, active: threads.some((thread) => !thread.isCoordinator) };
}
