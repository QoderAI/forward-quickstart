import { getSession, type ForwardContext, type ForwardEvent } from './forwardApi';
import { isTurnTerminal, stopReason, turnEventState } from './conversationTurns';

export async function waitForSessionStop(ctx: ForwardContext, sessionId: string, signal: AbortSignal) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('已请求停止，但尚未确认完成，请刷新会话状态后重试')), 30_000);
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    while (true) {
      combined.throwIfAborted();
      const session = await getSession(ctx, sessionId, { signal: combined });
      if (session.status === 'idle' || session.status === 'terminated') return session;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(delay);
          reject(combined.reason);
        };
        const delay = setTimeout(() => {
          combined.removeEventListener('abort', abort);
          resolve();
        }, 1000);
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface PendingToolApproval {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  questionUseId: string;
  questions: AskUserQuestion[];
  viaCustomTool: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedToolName(event: ForwardEvent): string {
  for (const value of [event.name, event.tool_name, event.tool]) {
    if (typeof value === 'string' && value) return value;
  }
  return 'UnknownTool';
}

function toolInput(event: ForwardEvent): Record<string, unknown> {
  return asRecord(event.input) ?? asRecord(event.arguments) ?? asRecord(event.parameters) ?? {};
}

function evaluatedPermission(event: ForwardEvent): string | undefined {
  if (typeof event.evaluated_permission === 'string') return event.evaluated_permission;
  if (Array.isArray(event.content)) {
    const block = event.content.map(asRecord).find((item) => item?.type === 'tool_use');
    if (typeof block?.evaluated_permission === 'string') return block.evaluated_permission;
  }
  return undefined;
}

function currentActionEvents(events: ForwardEvent[]) {
  const turn = events.slice(Math.max(0, events.findLastIndex(event => event.type === 'user.message')));
  return turn.some(event => isTurnTerminal(turnEventState(event))) ? [] : turn;
}

function requiresActionIds(event: ForwardEvent): string[] {
  const reason = event.type === 'session.status_idle' ? stopReason(event) : undefined;
  if (reason?.type !== 'requires_action' || !Array.isArray(reason.event_ids)) return [];
  return reason.event_ids.filter((id): id is string => typeof id === 'string');
}

function isQuestionToolName(name: string): boolean {
  return ['askuserquestion', 'ask_user_question', 'ask_user', 'askuser']
    .includes(name.trim().toLowerCase());
}

export function parseQuestions(value: unknown): AskUserQuestion[] {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { return []; }
  }
  const record = asRecord(source);
  const rawQuestions = Array.isArray(record?.questions) ? record.questions : [];
  return rawQuestions.flatMap((raw) => {
    const question = asRecord(raw);
    if (!question || typeof question.question !== 'string' || !question.question) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((rawOption) => {
      const option = asRecord(rawOption);
      if (!option || typeof option.label !== 'string' || !option.label) return [];
      return [{
        label: option.label,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      }];
    });
    return [{
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      options,
      multiSelect: question.multiSelect === true || question.multi_select === true,
    }];
  });
}

function questionInfo(event: ForwardEvent): PendingQuestion | null {
  if (event.type === 'agent.ask_user_question') {
    const questions = parseQuestions(event);
    return questions.length ? { questionUseId: event.id, questions, viaCustomTool: false } : null;
  }
  if (event.type === 'agent.custom_tool_use' && isQuestionToolName(normalizedToolName(event))) {
    const questions = parseQuestions(event.input);
    return questions.length ? { questionUseId: event.id, questions, viaCustomTool: true } : null;
  }
  return null;
}

export function derivePendingToolApprovals(history: ForwardEvent[]): PendingToolApproval[] {
  const events = currentActionEvents(history);
  const resolved = new Set(
    events
      .filter((event) => event.type === 'user.tool_confirmation')
      .map((event) => event.tool_use_id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const byId = new Map(events.map((event) => [event.id, event]));
  const pending: PendingToolApproval[] = [];
  const seen = new Set<string>();
  const idle = events.findLast(event => event.type === 'session.status_idle' || event.type === 'session.status_running');
  for (const id of idle ? requiresActionIds(idle) : []) {
    if (seen.has(id) || resolved.has(id)) continue;
    seen.add(id);
    const toolEvent = byId.get(id);
    if (!toolEvent || !['agent.tool_use', 'agent.mcp_tool_use'].includes(toolEvent.type)) continue;
    const permission = evaluatedPermission(toolEvent);
    if (permission === 'allow' || permission === 'deny') continue;
    pending.push({ toolUseId: id, toolName: normalizedToolName(toolEvent), input: toolInput(toolEvent) });
  }
  return pending;
}

export function derivePendingQuestion(history: ForwardEvent[]): PendingQuestion | null {
  const events = currentActionEvents(history);
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.type === 'user.question_answer' && typeof event.question_use_id === 'string') {
      resolved.add(event.question_use_id);
    }
    if (event.type === 'user.custom_tool_result' && typeof event.custom_tool_use_id === 'string') {
      resolved.add(event.custom_tool_use_id);
    }
  }
  const boundary = events.findLastIndex(event => event.type === 'session.status_running' || event.type === 'session.status_idle');
  const ids = boundary >= 0 ? requiresActionIds(events[boundary]) : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const info = questionInfo(events[index]);
    if (info && !resolved.has(info.questionUseId) && (index > boundary || ids.includes(info.questionUseId))) return info;
  }
  return null;
}

export function encodeQuestionAnswers(
  questions: AskUserQuestion[],
  answers: string[][],
  dismissed = false,
): string {
  if (dismissed) return 'The user dismissed this question without answering. Continue without their input.';
  const pairs = answers.map((answer, index) => {
    const question = questions[index]?.question || `question ${index + 1}`;
    return `"${question}"="${answer.length ? answer.join(', ') : 'Unanswered'}"`;
  });
  return `User has answered your questions: ${pairs.join(', ')}.`;
}
