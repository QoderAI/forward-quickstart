import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildLocalVoiceSocketUrl, isValidVoiceServerEvent, VoiceConnection } from './voiceConnection';

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  send = vi.fn();
  close = vi.fn();
  private listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();

  constructor() { FakeWebSocket.instances.push(this); }
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  emit(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

function installBrowser() {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('window', {
    location: { href: 'http://localhost:5173/' },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

describe('voice connection contract', () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('keeps credentials and conversation id out of the browser websocket URL', () => {
    const url = buildLocalVoiceSocketUrl('key only', 'http://localhost:5173/');
    expect(url).toBe('ws://localhost:5173/api/voice/socket?key=key+only');
    expect(url).not.toContain('conv_');
    expect(url).not.toContain('pat_');
  });
  test('validates the versioned server envelope and conversation', () => {
    const event = { version: 'voice.realtime.v1', type: 'voice.ready', event_id: 'evt_1', sequence: 1, conversation_id: 'conv_1', timestamp: '2026-08-15T00:00:00Z', payload: {} };
    expect(isValidVoiceServerEvent(event, 'conv_1')).toBe(true);
    expect(isValidVoiceServerEvent({ ...event, conversation_id: 'conv_2' }, 'conv_1')).toBe(false);
    expect(isValidVoiceServerEvent({ ...event, version: 'v0' }, 'conv_1')).toBe(false);
    expect(isValidVoiceServerEvent({ ...event, work_id: 42 }, 'conv_1')).toBe(false);
    expect(isValidVoiceServerEvent({ ...event, announcement_id: '' }, 'conv_1')).toBe(false);
  });

  test('waits for the matching gateway acknowledgement before graceful close completes', async () => {
    installBrowser();
    vi.stubGlobal('crypto', { randomUUID: () => 'close-request-1' });
    const connection = new VoiceConnection({
      conversationId: 'conv_1',
      getConnectionKey: async () => 'key-1',
      webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket,
    });
    await connection.connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit('message', { data: JSON.stringify({
      version: 'voice.realtime.v1', type: 'voice.ready', event_id: 'ready-1', sequence: 1,
      conversation_id: 'conv_1', timestamp: '2026-08-15T00:00:00Z',
      payload: { capabilities: { graceful_close: true } },
    }) });

    let completed = false;
    const closing = connection.closeGracefully().then((result) => { completed = true; return result; });
    expect(completed).toBe(false);
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({
      version: 'voice.realtime.v1', type: 'connection.close', payload: { request_id: 'close-request-1' },
    }));

    socket.emit('message', { data: JSON.stringify({
      version: 'voice.realtime.v1', type: 'connection.closed', event_id: 'closed-1', sequence: 2,
      conversation_id: 'conv_1', timestamp: '2026-08-15T00:00:01Z',
      payload: { request_id: 'close-request-1', outcome: 'saved_interrupted' },
    }) });
    await expect(closing).resolves.toEqual({ outcome: 'saved_interrupted' });
  });

  test('abandons graceful close when the gateway never acknowledges it', async () => {
    vi.useFakeTimers();
    installBrowser();
    vi.stubGlobal('crypto', { randomUUID: () => 'close-request-timeout' });
    const connection = new VoiceConnection({
      conversationId: 'conv_1',
      getConnectionKey: async () => 'key-1',
      webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket,
    });
    await connection.connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit('message', { data: JSON.stringify({
      version: 'voice.realtime.v1', type: 'voice.ready', event_id: 'ready-timeout', sequence: 1,
      conversation_id: 'conv_1', timestamp: '2026-08-15T00:00:00Z',
      payload: { capabilities: { graceful_close: true } },
    }) });

    let rejected = false;
    void connection.closeGracefully().catch(() => { rejected = true; });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(rejected).toBe(true);
    expect(socket.close).toHaveBeenCalled();
  });

  test('reconnects after a retryable server error even when the socket closes normally', async () => {
    vi.useFakeTimers();
    installBrowser();
    const connection = new VoiceConnection({
      conversationId: 'conv_1',
      getConnectionKey: async () => 'key-1',
      webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket,
    });
    await connection.connect();
    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify({
      version: 'voice.realtime.v1', type: 'error', event_id: 'error-1', sequence: 1,
      conversation_id: 'conv_1', timestamp: '2026-08-15T00:00:00Z',
      payload: { code: 'service_restarting', retryable: true, retry_after_ms: 500 },
    }) });
    FakeWebSocket.instances[0].emit('close', { code: 1000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
