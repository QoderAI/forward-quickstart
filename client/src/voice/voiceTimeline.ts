import type { RealtimeHistoryEvent } from './voiceApi';
import type { VoiceServerEvent } from './voiceConnection';

export interface CaptionEntry { kind: 'caption'; id: string; role: 'user' | 'assistant'; text: string; pending: boolean; turnId?: string }
export interface WorkStep { kind: string; title?: string; detail?: string; isError?: boolean }
export interface WorkEntry { kind: 'work'; id: string; workId: string; objective: string; status: string; steps: WorkStep[]; result?: string; turnId?: string }
export type TimelineEntry = CaptionEntry | WorkEntry;

interface TimelineEntity { entry: TimelineEntry; streamId?: string; terminal: boolean }
export interface VoiceTimelineState {
  order: string[];
  entities: Record<string, TimelineEntity>;
  activeCaptions: Partial<Record<'user' | 'assistant', string>>;
  completedStreams: Record<string, true>;
  sealedStreams: Record<string, string>;
  localUserTextBySignature: Record<string, string>;
}

const terminalWorkStatuses = new Set(['completed', 'failed', 'cancelled']);
const MAX_WORK_STEPS = 40;

export function createVoiceTimelineState(): VoiceTimelineState {
  return { order: [], entities: {}, activeCaptions: {}, completedStreams: {}, sealedStreams: {}, localUserTextBySignature: {} };
}

export function createVoiceTimelineStateFromEntries(entries: TimelineEntry[]): VoiceTimelineState {
  const state = createVoiceTimelineState();
  for (const entry of entries) {
    const key = entry.kind === 'work' ? `work:${entry.workId}` : `message:${entry.id}`;
    if (state.entities[key]) continue;
    state.order.push(key);
    state.entities[key] = { entry, terminal: entry.kind === 'caption' ? !entry.pending : terminalWorkStatuses.has(entry.status) };
  }
  return state;
}

export function selectTimelineEntries(state: VoiceTimelineState): TimelineEntry[] {
  return state.order.flatMap((key) => state.entities[key] ? [state.entities[key].entry] : []);
}

function textValue(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function trimmedTextValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function normalizeTranscript(text: string): string { return text.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
function transcriptSignature(role: 'user' | 'assistant', text: string): string { const normalized = normalizeTranscript(text); return normalized ? `${role}:${normalized}` : ''; }
function reconcileUserTranscriptFinal(delta: string, final: string): string {
  const comparableDelta = delta.normalize('NFKC');
  const finalWithoutTrailingSymbols = final.normalize('NFKC').trim().replace(/[\s\p{P}\p{S}]+$/gu, '');
  return finalWithoutTrailingSymbols && comparableDelta.includes(finalWithoutTrailingSymbols) ? delta : final;
}
function transcriptStreamId(event: VoiceServerEvent, role: 'user' | 'assistant'): string | undefined { return textValue(role === 'assistant' ? event.payload.response_id : event.payload.item_id); }
function streamKey(role: 'user' | 'assistant', streamId: string | undefined): string | undefined { return streamId ? `${role}:${streamId}` : undefined; }

function sealActiveCaption(state: VoiceTimelineState, role: 'user' | 'assistant'): VoiceTimelineState {
  const key = state.activeCaptions[role];
  if (!key) return state;
  const current = state.entities[key];
  const activeCaptions = { ...state.activeCaptions };
  delete activeCaptions[role];
  if (!current || current.entry.kind !== 'caption' || current.terminal) return { ...state, activeCaptions };
  const sealedKey = streamKey(role, current.streamId);
  return {
    ...state,
    activeCaptions,
    sealedStreams: sealedKey ? { ...state.sealedStreams, [sealedKey]: current.entry.text } : state.sealedStreams,
    entities: { ...state.entities, [key]: { ...current, entry: { ...current.entry, pending: false }, terminal: true } },
  };
}

function applyTranscript(state: VoiceTimelineState, event: VoiceServerEvent): VoiceTimelineState {
  const final = event.type === 'transcript.final';
  if (!final && event.type !== 'transcript.delta') return state;
  const role = event.payload.role;
  const text = textValue(event.payload.text);
  if ((role !== 'user' && role !== 'assistant') || text === undefined) return state;

  const streamId = transcriptStreamId(event, role);
  const completedKey = streamKey(role, streamId);
  if (completedKey && state.completedStreams[completedKey]) return state;
  const sealedText = completedKey ? state.sealedStreams[completedKey] : undefined;
  if (completedKey && sealedText !== undefined) {
    if (!final) return state;
    if (text === sealedText) return { ...state, completedStreams: { ...state.completedStreams, [completedKey]: true } };
  }

  let next = role === 'user' ? sealActiveCaption(state, 'assistant') : state;
  const signature = final ? transcriptSignature(role, text) : '';
  const localKey = role === 'user' && signature ? next.localUserTextBySignature[signature] : undefined;
  const local = localKey ? next.entities[localKey] : undefined;
  if (localKey && local?.entry.kind === 'caption' && local.entry.role === 'user') {
    const localUserTextBySignature = { ...next.localUserTextBySignature };
    delete localUserTextBySignature[signature];
    return {
      ...next,
      activeCaptions: final ? { ...next.activeCaptions, user: undefined } : next.activeCaptions,
      completedStreams: final && completedKey ? { ...next.completedStreams, [completedKey]: true } : next.completedStreams,
      localUserTextBySignature,
      entities: { ...next.entities, [localKey]: { ...local, streamId, entry: { ...local.entry, text, pending: !final }, terminal: final } },
    };
  }

  let key = next.activeCaptions[role];
  let current = key ? next.entities[key] : undefined;
  if (current?.streamId && streamId && current.streamId !== streamId) {
    next = sealActiveCaption(next, role);
    key = undefined;
    current = undefined;
  }
  if (current && key) {
    if (current.entry.kind !== 'caption' || current.entry.role !== role || current.terminal) return next;
    const nextText = final && role === 'user'
      ? reconcileUserTranscriptFinal(current.entry.text, text)
      : final || role === 'user'
        ? text
        : current.entry.text + text;
    const entry: CaptionEntry = { ...current.entry, text: nextText, pending: !final };
    return {
      ...next,
      activeCaptions: final ? { ...next.activeCaptions, [role]: undefined } : next.activeCaptions,
      completedStreams: final && completedKey ? { ...next.completedStreams, [completedKey]: true } : next.completedStreams,
      entities: { ...next.entities, [key]: { ...current, entry, terminal: final } },
    };
  }

  key = `message:${event.event_id}`;
  return {
    ...next,
    order: [...next.order, key],
    activeCaptions: final ? next.activeCaptions : { ...next.activeCaptions, [role]: key },
    completedStreams: final && completedKey ? { ...next.completedStreams, [completedKey]: true } : next.completedStreams,
    entities: { ...next.entities, [key]: { entry: { kind: 'caption', id: event.event_id, role, text, pending: !final }, streamId, terminal: final } },
  };
}

export function upsertLocalUserTextDraft(state: VoiceTimelineState, id: string, text: string, pending: boolean): VoiceTimelineState {
  const key = `message:${id}`;
  const current = state.entities[key];
  const previousSignature = current?.entry.kind === 'caption' ? transcriptSignature('user', current.entry.text) : '';
  const nextSignature = transcriptSignature('user', text);
  const localUserTextBySignature = { ...state.localUserTextBySignature };
  if (previousSignature) delete localUserTextBySignature[previousSignature];
  if (nextSignature) localUserTextBySignature[nextSignature] = key;
  return {
    ...state,
    order: current ? state.order : [...state.order, key],
    localUserTextBySignature,
    entities: { ...state.entities, [key]: { entry: { kind: 'caption', id, role: 'user', text, pending }, terminal: !pending } },
  };
}

export function removeTimelineEntry(state: VoiceTimelineState, id: string): VoiceTimelineState {
  const key = `message:${id}`;
  const current = state.entities[key];
  if (!current) return state;
  const entities = { ...state.entities };
  delete entities[key];
  const localUserTextBySignature = { ...state.localUserTextBySignature };
  if (current.entry.kind === 'caption') {
    const signature = transcriptSignature(current.entry.role, current.entry.text);
    if (signature) delete localUserTextBySignature[signature];
  }
  return { ...state, order: state.order.filter((entryKey) => entryKey !== key), entities, localUserTextBySignature };
}

function workStatus(event: VoiceServerEvent, current: string): string {
  if (event.type === 'work.accepted') return 'accepted';
  if (event.type === 'work.started' || event.type === 'work.running' || event.type === 'work.progress') return 'running';
  if (event.type === 'work.queued') return 'queued';
  if (event.type === 'work.completed') return 'completed';
  if (event.type === 'work.cancelled') return 'cancelled';
  if (event.type === 'work.failed') return (event.payload.error as { code?: unknown } | undefined)?.code === 'work_cancelled' ? 'cancelled' : 'failed';
  return current;
}

function applyWork(state: VoiceTimelineState, event: VoiceServerEvent): VoiceTimelineState {
  if (!event.type.startsWith('work.') || !event.work_id) return state;
  const key = `work:${event.work_id}`;
  const current = state.entities[key];
  if (current && (current.entry.kind !== 'work' || current.terminal)) return state;
  const previous = current?.entry as WorkEntry | undefined;
  const status = workStatus(event, textValue(event.payload.status) ?? previous?.status ?? 'accepted');
  const steps = previous ? [...previous.steps] : [];
  if (event.type === 'work.progress' && steps.length < MAX_WORK_STEPS) {
    const title = trimmedTextValue(event.payload.title);
    const detail = trimmedTextValue(event.payload.detail) ?? trimmedTextValue(event.payload.text);
    if (title || detail) steps.push({ kind: trimmedTextValue(event.payload.kind) ?? 'message', ...(title ? { title } : {}), ...(detail ? { detail } : {}), ...(event.payload.is_error ? { isError: true } : {}) });
  }
  if (event.type === 'work.milestone' && steps.length < MAX_WORK_STEPS) {
    const detail = trimmedTextValue(event.payload.summary);
    if (detail) steps.push({ kind: 'milestone', detail });
  }
  const errorCode = (event.payload.error as { code?: unknown } | undefined)?.code;
  const result = textValue(event.payload.result) ?? (status === 'failed' ? textValue(errorCode) : undefined) ?? previous?.result;
  const entry: WorkEntry = {
    kind: 'work', id: event.work_id, workId: event.work_id,
    objective: textValue(event.payload.objective) ?? previous?.objective ?? `后台任务 ${event.work_id.slice(-6)}`,
    status, steps, ...(result ? { result } : {}),
  };
  return { ...state, order: current ? state.order : [...state.order, key], entities: { ...state.entities, [key]: { entry, terminal: terminalWorkStatuses.has(status) } } };
}

export function applyVoiceTimelineEvent(state: VoiceTimelineState, event: VoiceServerEvent): VoiceTimelineState {
  if (event.type.startsWith('transcript.')) return applyTranscript(state, event);
  if (event.type.startsWith('work.')) return applyWork(state, event);
  return state;
}

export function projectVoiceHistory(events: RealtimeHistoryEvent[]): TimelineEntry[] {
  const state = createVoiceTimelineState();
  const seen = new Set<string>();
  for (const event of events.map((event, index) => ({ event, index })).sort((a, b) => Date.parse(a.event.occurred_at) - Date.parse(b.event.occurred_at) || a.index - b.index).map(({ event }) => event)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.role && event.text && ['voice.user_message.completed', 'voice.assistant_message.completed', 'voice.assistant_message.interrupted'].includes(event.type)) {
      const key = `message:${event.id}`;
      state.order.push(key);
      state.entities[key] = { entry: { kind: 'caption', id: event.id, role: event.role, text: event.text, pending: false, ...(event.turn_id ? { turnId: event.turn_id } : {}) }, terminal: true };
      continue;
    }
    if (!event.work_id || !event.type.startsWith('voice.work.')) continue;
    const key = `work:${event.work_id}`;
    const current = state.entities[key]?.entry as WorkEntry | undefined;
    const status = event.type.endsWith('progress_announced') ? 'running' : event.type.split('.').at(-1)!;
    const card: WorkEntry = current || { kind: 'work', id: event.work_id, workId: event.work_id, objective: event.objective || `后台任务 ${event.work_id.slice(-6)}`, status: 'accepted', steps: [], ...(event.turn_id ? { turnId: event.turn_id } : {}) };
    if (!current) state.order.push(key);
    if (event.objective) card.objective = event.objective;
    card.status = event.error?.code === 'work_cancelled' ? 'cancelled' : status;
    if (event.type.endsWith('progress_announced') && event.text) card.steps.push({ kind: 'message', detail: event.text });
    if (event.result) card.result = event.result;
    if (event.error?.code && card.status === 'failed') card.result = event.error.code;
    state.entities[key] = { entry: card, terminal: terminalWorkStatuses.has(card.status) };
  }
  return selectTimelineEntries(state);
}
