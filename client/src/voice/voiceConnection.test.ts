import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildVoiceSocketUrl, isValidVoiceServerEvent, VoiceConnection } from './voiceConnection';

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
    const url = buildVoiceSocketUrl('http://localhost:5173/');
    expect(url).toBe('ws://localhost:5173/api/voice/socket');
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
      getCredentials: async () => ({ pat: 'pat_secret', environment: 'cn-prod' }),
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
      getCredentials: async () => ({ pat: 'pat_secret', environment: 'cn-prod' }),
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
      getCredentials: async () => ({ pat: 'pat_secret', environment: 'cn-prod' }),
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
  test('sends credentials only after open and uses WSS on HTTPS', async () => {
    installBrowser();
    expect(buildVoiceSocketUrl('https://demo.vercel.app/path')).toBe('wss://demo.vercel.app/api/voice/socket');
    const connection = new VoiceConnection({ conversationId: 'conv_1', getCredentials: async () => ({ pat: 'secret', environment: 'global-prod' }), webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket });
    await connection.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit('open');
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'proxy.auth', pat: 'secret', environment: 'global-prod', conversation_id: 'conv_1' });
    expect(connection.send('audio.append', {})).toBe(false);
    connection.disconnect();
  });

  test.each([1001, 1006, 1012])('restores history and authenticates again after close %s', async code => {
    vi.useFakeTimers(); installBrowser();
    const credentials = vi.fn(async () => ({ pat: 'secret', environment: 'cn-prod' as const }));
    const restore = vi.fn(async () => {});
    const connection = new VoiceConnection({ conversationId: 'conv_1', getCredentials: credentials, beforeReconnect: restore, webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket });
    await connection.connect();
    FakeWebSocket.instances[0].emit('close', { code });
    await vi.advanceTimersByTimeAsync(1000);
    expect(restore).toHaveBeenCalledOnce();
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    connection.disconnect();
  });

  test('authentication failure does not retry even after a browser error', async () => {
    vi.useFakeTimers(); installBrowser();
    const onError = vi.fn();
    const connection = new VoiceConnection({ conversationId: 'conv_1', getCredentials: async () => ({ pat: 'secret', environment: 'cn-prod' }), onError, webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket });
    await connection.connect();
    FakeWebSocket.instances[0].emit('error');
    FakeWebSocket.instances[0].emit('close', { code: 4401 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onError.mock.calls[0][0].code).toBe('proxy_auth_failed');
    connection.disconnect();
  });

  test('readiness timeout closes obsolete sockets and stops after three retries', async () => {
    vi.useFakeTimers(); installBrowser();
    const onError = vi.fn();
    const connection = new VoiceConnection({ conversationId: 'conv_1', getCredentials: async () => ({ pat: 'secret', environment: 'cn-prod' }), onError, webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket });
    await connection.connect();
    await vi.advanceTimersByTimeAsync(128000);
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(FakeWebSocket.instances.every(s => s.close.mock.calls.length === 1)).toBe(true);
    expect(onError.mock.calls[0][0].code).toBe('realtime_connection_failed');
    connection.disconnect();
  });

  test('manual disconnect cancels scheduled reconnect', async () => {
    vi.useFakeTimers(); installBrowser();
    const connection = new VoiceConnection({ conversationId: 'conv_1', getCredentials: async () => ({ pat: 'secret', environment: 'cn-prod' }), webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket });
    await connection.connect();
    FakeWebSocket.instances[0].emit('close', { code: 1012 });
    connection.disconnect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

});
