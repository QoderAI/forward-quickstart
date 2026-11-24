import type { ForwardEvent } from './forwardApi';

export type TurnState = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'terminated' | 'unknown';
export type ToolState = 'running' | 'waiting' | 'done' | 'failed' | 'denied' | 'unknown';

export type ProcessStep =
  | { kind: 'thinking' | 'narration' | 'coordination'; event: ForwardEvent }
  | { kind: 'tool'; event: ForwardEvent; result?: ForwardEvent; state: ToolState };

export interface ConversationTurn {
  key: string;
  user?: ForwardEvent;
  events: ForwardEvent[];
  steps: ProcessStep[];
  answers: ForwardEvent[];
  tools: Extract<ProcessStep, { kind: 'tool' }>[];
  errors: ForwardEvent[];
  state: TurnState;
  partial: boolean;
  elapsedMs: number | undefined;
  runningSince: number | undefined;
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function stopReason(event: ForwardEvent) {
  return recordOf(event.stop_reason) ?? recordOf(recordOf(event.content)?.stop_reason);
}

export function turnEventState(event: ForwardEvent): TurnState | undefined {
  switch (event.type) {
    case 'session.status_running': return 'running';
    case 'session.error': return 'failed';
    case 'session.status_terminated': return 'terminated';
    case 'session.cancelled':
    case 'session.canceled':
    case 'local.stop_confirmed': return 'stopped';
    case 'session.completed': return 'done';
    case 'session.status_idle': {
      const reason = stopReason(event)?.type;
      if (reason === 'requires_action') return 'waiting';
      if (reason === 'cancelled' || reason === 'canceled') return 'stopped';
      return reason === 'end_turn' ? 'done' : 'unknown';
    }
    default: return undefined;
  }
}

export function isTurnTerminal(state?: TurnState): boolean {
  return state === 'done' || state === 'failed' || state === 'stopped' || state === 'terminated';
}

export function latestTurnState(events: ForwardEvent[], afterId?: string, startedAt?: string): TurnState | undefined {
  const anchor = afterId ? events.findIndex(event => event.id === afterId) : -1;
  for (let i = events.length - 1; i > anchor; i--) {
    const event = events[i];
    if (event.type === 'user.message') break;
    if (anchor < 0 && startedAt && (event.processed_at || event.created_at || '') <= startedAt) continue;
    const state = turnEventState(event);
    if (state) return state;
  }
  return undefined;
}

export function eventTimestamp(event: ForwardEvent): number | undefined {
  const value = Date.parse(event.processed_at || event.created_at || '');
  return Number.isFinite(value) ? value : undefined;
}

function toolFamily(event: ForwardEvent) {
  if (/^agent\.tool_(use|result)$/.test(event.type)) return 'tool';
  if (/^agent\.mcp_tool_(use|result)$/.test(event.type)) return 'mcp_tool';
  if (/^agent\.custom_tool_(use|result)$/.test(event.type) || event.type === 'user.custom_tool_result') return 'custom_tool';
}

function toolReference(event: ForwardEvent) {
  const family = toolFamily(event);
  const reference = family && (event[`${family}_use_id`] ?? event.tool_call_id);
  return typeof reference === 'string' && reference ? `${family}:${reference}` : undefined;
}

function isToolUse(event: ForwardEvent) {
  return Boolean(toolFamily(event) && event.type.endsWith('_use'));
}

function toolFailed(event: ForwardEvent) {
  const payload = recordOf(event.result) ?? recordOf(event.output) ?? recordOf(event.content);
  return event.is_error === true || event.status === 'failed' || event.status === 'error' || Boolean(event.error)
    || payload?.is_error === true || payload?.success === false;
}

function projectTurn(events: ForwardEvent[], user: ForwardEvent | undefined, partial: boolean, hasNext: boolean): ConversationTurn {
  let state: TurnState = user?.id.startsWith('local-') ? 'pending' : 'unknown';
  let runningSince: number | undefined;
  let elapsedMs = 0;
  let knownTimes = false;
  let invalidTimes = false;
  const steps: ProcessStep[] = [];
  const errors: ForwardEvent[] = [];
  const answers: ForwardEvent[] = [];
  const confirmations = new Map(events.filter(e => e.type === 'user.tool_confirmation').map(e => [e.tool_use_id, e.result]));
  const usesByRef = new Map<string, ForwardEvent>();
  for (const event of events) {
    if (!isToolUse(event)) continue;
    usesByRef.set(`${toolFamily(event)}:${event.id}`, event);
    const ref = toolReference(event);
    if (ref) usesByRef.set(ref, event);
  }
  const results = new Map<string, ForwardEvent>();
  const resultOwners = new Map<string, string>();
  for (const event of events) {
    if (!toolFamily(event) || isToolUse(event)) continue;
    const owner = usesByRef.get(toolReference(event) ?? '');
    if (!owner) continue;
    resultOwners.set(event.id, owner.id);
    const previous = results.get(owner.id);
    if (!previous || event.type.startsWith('agent.')) results.set(owner.id, event);
  }

  let lastAction = -1;
  let waitingIds = new Set<unknown>();
  for (const [index, event] of events.entries()) {
    if (isToolUse(event) || event.type === 'agent.ask_user_question' || event.type === 'agent.thread_message_sent') lastAction = index;
    const next = turnEventState(event);
    if (event.type === 'session.error') errors.push(event);
    if (state === 'waiting') {
      const actionId = event.type === 'user.tool_confirmation' ? event.tool_use_id
        : event.type === 'user.custom_tool_result' ? event.custom_tool_use_id
        : event.type === 'user.question_answer' ? event.question_use_id : undefined;
      if (actionId && waitingIds.delete(actionId) && !waitingIds.size) state = 'unknown';
    }
    if (!next || isTurnTerminal(state) && !(state === 'done' && next === 'failed')) continue;
    if (next === 'running') {
      if (state !== 'running') {
        runningSince = eventTimestamp(event);
        invalidTimes ||= runningSince === undefined;
      }
    } else if (state === 'running') {
      const end = eventTimestamp(event);
      if (runningSince === undefined || end === undefined || end < runningSince) invalidTimes = true;
      else {
        elapsedMs += end - runningSince;
        knownTimes = true;
      }
      runningSince = undefined;
    }
    state = next;
    const ids = stopReason(event)?.event_ids;
    waitingIds = new Set(next === 'waiting' && Array.isArray(ids) ? ids : []);
  }
  if (hasNext && !isTurnTerminal(state)) {
    state = 'unknown';
    runningSince = undefined;
  }

  for (const [index, event] of events.entries()) {
    if (event.type === 'agent.message') {
      if (index < lastAction && !event.stream_event_id && !event.id.startsWith('local-stream-')) steps.push({ kind: 'narration', event });
      else answers.push(event);
    } else if (event.type === 'agent.thinking' && (event.stream_event_id || !event.id.startsWith('local-'))) {
      steps.push({ kind: 'thinking', event });
    } else if (/^session\.thread_|^agent\.thread_message_/.test(event.type)) {
      steps.push({ kind: 'coordination', event });
    } else if (isToolUse(event)) {
      const result = results.get(event.id);
      const permission = confirmations.get(event.id) ?? confirmations.get(event.tool_use_id) ?? event.evaluated_permission;
      const toolState = permission === 'deny' ? 'denied'
        : result ? toolFailed(result) ? 'failed' : 'done'
        : waitingIds.has(event.id) || waitingIds.has(event.tool_use_id) ? 'waiting'
        : !hasNext && (state === 'running' || state === 'pending') ? 'running' : 'unknown';
      steps.push({ kind: 'tool', event, result, state: toolState });
    } else if (toolFamily(event) && event.type.startsWith('agent.') && !resultOwners.has(event.id)) {
      steps.push({ kind: 'tool', event, result: event, state: toolFailed(event) ? 'failed' : 'done' });
    }
  }

  return {
    key: user ? String(user.view_turn_key ?? user.id) : `history-${events[0].session_id}`,
    user, events, steps, answers, errors, state, partial,
    tools: steps.filter((step): step is Extract<ProcessStep, { kind: 'tool' }> => step.kind === 'tool'),
    elapsedMs: !invalidTimes && (knownTimes || runningSince !== undefined) ? elapsedMs : undefined,
    runningSince: !invalidTimes ? runningSince : undefined,
  };
}

export function projectConversation(events: ForwardEvent[], hasOlder: boolean): ConversationTurn[] {
  const groups: { user?: ForwardEvent; events: ForwardEvent[] }[] = [];
  for (const event of events) {
    if (event.type === 'user.message' || !groups.length || groups.at(-1)?.events[0]?.session_id !== event.session_id) {
      groups.push({ user: event.type === 'user.message' ? event : undefined, events: [] });
    }
    groups.at(-1)!.events.push(event);
  }
  return groups.flatMap((group, i) => {
    const partial = i === 0 && !group.user && hasOlder;
    if (!group.user && !partial && group.events.every(event =>
      event.type.startsWith('session.thread_') || event.type === 'session.created' || event.type === 'session.updated'
      || event.type === 'session.usage' || turnEventState(event) === 'unknown',
    )) return [];
    return [projectTurn(group.events, group.user, partial, i < groups.length - 1)];
  });
}

export function mergeConversationEvents(current: ForwardEvent[], incoming: ForwardEvent[], mode: 'stream' | 'older' | 'history' = 'stream'): ForwardEvent[] {
  if (!incoming.length) return current;
  const updates = new Map(incoming.map(event => [event.id, event]));
  const known = new Set(current.map(event => event.id));
  const actionReference = (event: ForwardEvent) => event.type === 'user.tool_confirmation' ? event.tool_use_id
    : event.type === 'user.question_answer' ? event.question_use_id
    : event.type === 'user.custom_tool_result' ? event.custom_tool_use_id : undefined;
  const resolvedActions = new Set(incoming.filter(event => !event.id.startsWith('local-') && actionReference(event))
    .map(event => `${event.type}:${actionReference(event)}`));
  const contentFor = (event: ForwardEvent, previous: ForwardEvent) => {
    const content = event.content;
    return content == null || event.type === 'agent.thinking' && (content === '' || Array.isArray(content) && !content.length)
      ? previous.content : content;
  };
  const next = current.flatMap(event => {
    if (event.id.startsWith('local-') && resolvedActions.has(`${event.type}:${actionReference(event)}`)) return [];
    const replacement = typeof event.stream_event_id === 'string' ? updates.get(event.stream_event_id) : undefined;
    if (replacement) {
      if (known.has(replacement.id)) return [];
      return [{ ...replacement, content: contentFor(replacement, event) }];
    }
    const update = updates.get(event.id);
    return [update ? { ...event, ...update, created_at: update.created_at ?? event.created_at,
      processed_at: update.processed_at ?? event.processed_at, content: contentFor(update, event) } : event];
  });
  const existing = new Map(next.map(event => [event.id, event]));
  const canonical = [...updates.values()].map(event => existing.get(event.id) ?? event);
  if (mode === 'stream') return [...next, ...canonical.filter(event => !existing.has(event.id))];
  if (mode === 'older' && !canonical.some(event => existing.has(event.id))) return [...canonical, ...next];

  const positions = new Map(canonical.map((event, index) => [event.id, index]));
  const nextAnchor = Array<number>(next.length);
  let after = canonical.length;
  for (let i = next.length - 1; i >= 0; i--) {
    nextAnchor[i] = after;
    after = positions.get(next[i].id) ?? after;
  }
  const gaps = Array.from({ length: canonical.length + 1 }, () => [] as ForwardEvent[]);
  let before = -1;
  let gap = 0;
  for (const [i, event] of next.entries()) {
    const index = positions.get(event.id);
    if (index !== undefined) {
      before = Math.max(before, index);
      continue;
    }
    const limit = Math.max(before + 1, nextAnchor[i]);
    const first = Math.max(gap, before + 1);
    const time = eventTimestamp(event);
    let position = limit;
    for (let j = first; j < limit; j++) {
      const other = canonical[j];
      const otherTime = eventTimestamp(other);
      if (time !== undefined && otherTime !== undefined && time < otherTime
          || event.id.startsWith('local-stream-') && (other.type === 'user.message' || isTurnTerminal(turnEventState(other)))) {
        position = j;
        break;
      }
    }
    if (before < 0 && nextAnchor[i] === canonical.length && mode === 'history' && !event.id.startsWith('local-') && time === undefined) position = first;
    gap = Math.max(gap, position);
    gaps[gap].push(event);
  }
  return [...canonical.flatMap((event, i) => [...gaps[i], event]), ...gaps[canonical.length]];
}

export function commitConversationTurn(current: ForwardEvent[], localId: string, incoming: ForwardEvent[]) {
  const anchor = incoming.find(event => event.type === 'user.message');
  const local = current.find(event => event.id === localId);
  if (!anchor || !local) return mergeConversationEvents(current, incoming);
  const hasAnchor = current.some(event => event.id === anchor.id);
  const next = current.flatMap(event => {
    if (event.id === anchor.id || event.id === localId && !hasAnchor) return [{ ...anchor, ...event.id === anchor.id ? event : {}, view_turn_key: localId }];
    return event.id === localId ? [] : [event];
  });
  return mergeConversationEvents(next, incoming);
}

export function totalCredits(value: unknown): number | undefined {
  const credits = recordOf(value)?.total_credits;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0 ? credits : undefined;
}

export function conversationCredits(events: ForwardEvent[], session?: { usage?: unknown; updated_at?: string }): number | undefined {
  const fallback = totalCredits(session?.usage);
  const sessionTime = Date.parse(session?.updated_at || '');
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'session.usage') continue;
    const credits = totalCredits(event) ?? totalCredits(event.usage);
    if (credits === undefined) continue;
    const at = eventTimestamp(event);
    return fallback !== undefined && at !== undefined && sessionTime > at ? fallback : credits;
  }
  return fallback;
}

function shortDisplay(value: string) {
  return value.replace(/https?:\/\/[^\s]+/gi, (url) => {
    try { return new URL(url).hostname; } catch { return '链接'; }
  }).replace(/\b(?:bearer\s+\S+|(?:token|password|secret|api[-_]?key)\s*[:=]\s*\S+)/gi, '***').slice(0, 120);
}

export function toolInputDetails(name: string, source: unknown) {
  const tool = name.toLowerCase();
  if (tool !== 'bash' && tool !== 'grep') return;
  const input = recordOf(source);
  const command = typeof input?.command === 'string' ? input.command : typeof source === 'string' && tool === 'bash' ? source : '';
  if (command.trim()) return { label: '查看完整命令', text: command };
  if (tool === 'grep') {
    if (typeof source === 'string' && source.trim()) return { label: '查看完整参数', text: source };
    if (input && Object.keys(input).length) return { label: '查看完整参数', text: JSON.stringify(input, null, 2) };
  }
}

export function toolSummary(name: string, source: unknown): string {
  const input = recordOf(source);
  if (!input) return '';
  if (['websearch', 'web_search', 'search'].includes(name.toLowerCase())) {
    const query = input.query ?? input.search_query;
    return typeof query === 'string' ? shortDisplay(query) : '';
  }
  if (['webfetch', 'web_fetch', 'browser'].includes(name.toLowerCase()) && typeof input.url === 'string') {
    try {
      const url = new URL(input.url);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname : '';
    } catch { return ''; }
  }
  if (['read', 'write', 'edit', 'read_file', 'write_file'].includes(name.toLowerCase())) {
    const path = input.file_path ?? input.path;
    return typeof path === 'string' ? shortDisplay(path.split(/[\\/]/).at(-1) ?? '') : '';
  }
  return '';
}
