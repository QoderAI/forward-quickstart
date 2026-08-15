import type { ForwardEvent } from './forwardApi';

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

function stopReasonForEvent(event: ForwardEvent): Record<string, unknown> | undefined {
  if (event.type !== 'session.status_idle') return undefined;
  return asRecord(event.stop_reason) ?? asRecord(asRecord(event.content)?.stop_reason);
}

function requiresActionIds(event: ForwardEvent): string[] {
  const stopReason = stopReasonForEvent(event);
  if (stopReason?.type !== 'requires_action' || !Array.isArray(stopReason.event_ids)) return [];
  return stopReason.event_ids.filter((id): id is string => typeof id === 'string');
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

export function derivePendingToolApprovals(events: ForwardEvent[]): PendingToolApproval[] {
  const resolved = new Set(
    events
      .filter((event) => event.type === 'user.tool_confirmation')
      .map((event) => event.tool_use_id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const byId = new Map(events.map((event) => [event.id, event]));
  const pending: PendingToolApproval[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    for (const id of requiresActionIds(event)) {
      if (seen.has(id) || resolved.has(id)) continue;
      seen.add(id);
      const toolEvent = byId.get(id);
      if (!toolEvent || questionInfo(toolEvent)) continue;
      // Client-side custom tools wait for user.custom_tool_result, not confirmation.
      if (toolEvent.type === 'agent.custom_tool_use') continue;
      const permission = evaluatedPermission(toolEvent);
      if (permission === 'allow' || permission === 'deny') continue;
      pending.push({ toolUseId: id, toolName: normalizedToolName(toolEvent), input: toolInput(toolEvent) });
    }
  }
  return pending;
}

export function derivePendingQuestion(events: ForwardEvent[]): PendingQuestion | null {
  const resolved = new Set<string>();
  const terminatedTurns = new Set<string>();
  for (const event of events) {
    if (event.type === 'user.question_answer' && typeof event.question_use_id === 'string') {
      resolved.add(event.question_use_id);
    }
    if (event.type === 'user.custom_tool_result' && typeof event.custom_tool_use_id === 'string') {
      resolved.add(event.custom_tool_use_id);
    }
    const stopReason = stopReasonForEvent(event);
    if (stopReason && stopReason.type !== 'requires_action' && typeof event.turn_id === 'string') {
      terminatedTurns.add(event.turn_id);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const info = questionInfo(event);
    if (
      info
      && !resolved.has(info.questionUseId)
      && !(typeof event.turn_id === 'string' && terminatedTurns.has(event.turn_id))
    ) return info;
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
