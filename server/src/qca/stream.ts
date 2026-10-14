import { once } from 'node:events';
import type { Response as ExpressResponse } from 'express';

export function isTerminalSseFrame(frame: string): boolean {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
  if (data === '[DONE]') return true;
  let event;
  try { event = JSON.parse(data); } catch { return false; }
  // A child thread going idle does not end its parent session's stream.
  if (['session.completed', 'session.error', 'session.cancelled', 'session.canceled', 'session.status_terminated'].includes(event?.type)) return true;
  return event?.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action';
}

export async function relaySse(body: ReadableStream<Uint8Array>, res: ExpressResponse, signal: AbortSignal) {
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? '';
      if (!res.write(value)) await once(res, 'drain', { signal });
      (res as ExpressResponse & { flush?: () => void }).flush?.();
      if (frames.some(isTerminalSseFrame)) break;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
