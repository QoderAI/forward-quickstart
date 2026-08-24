const VERSION = 'voice.realtime.v1';
const RETRY_DELAYS = [1000, 2000, 4000];
const RETRY_CODES = new Set([1006, 1011, 1012, 1013]);
const HEARTBEAT_INTERVAL_MS = 25_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;

export interface VoiceServerEvent { version: string; type: string; event_id: string; sequence: number; conversation_id: string; timestamp: string; work_id?: string; announcement_id?: string; payload: Record<string, unknown> }
export type VoiceConnectionState = 'connecting' | 'reconnecting' | 'disconnected' | 'replaced';
export interface VoiceCloseResult { outcome: string }
export class VoiceClientError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

export function buildLocalVoiceSocketUrl(key: string, base = window.location.href) {
  const url = new URL('/api/voice/socket', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('key', key);
  return url.toString();
}

export function isValidVoiceServerEvent(value: unknown, conversationId: string): value is VoiceServerEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<VoiceServerEvent>;
  const validWorkId = event.work_id === undefined || (typeof event.work_id === 'string' && !!event.work_id);
  const validAnnouncementId = event.announcement_id === undefined || (typeof event.announcement_id === 'string' && !!event.announcement_id);
  return event.version === VERSION && typeof event.type === 'string' && !!event.type && typeof event.event_id === 'string' && !!event.event_id && Number.isInteger(event.sequence) && Number(event.sequence) > 0 && event.conversation_id === conversationId && typeof event.timestamp === 'string' && !!event.timestamp && validWorkId && validAnnouncementId && !!event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload);
}

interface VoiceConnectionOptions {
  conversationId: string;
  getConnectionKey: () => Promise<string>;
  beforeReconnect?: () => Promise<void>;
  onEvent?: (event: VoiceServerEvent) => void;
  onState?: (state: VoiceConnectionState) => void;
  onReconnect?: (attempt: number, maxAttempts: number) => void;
  onError?: (error: VoiceClientError) => void;
  webSocketFactory?: (url: string) => WebSocket;
}

export class VoiceConnection {
  ready = false;
  private options: VoiceConnectionOptions;
  private socket: WebSocket | null = null;
  private generation = 0;
  private attemptActive = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private heartbeat: number | null = null;
  private manual = false;
  private replaced = false;
  private retryOnClose = false;
  private requestedRetryAfterMs = 0;
  private lastSequence = 0;
  private seen = new Set<string>();
  private graceful = false;
  private pendingClose: {
    requestId: string;
    promise: Promise<VoiceCloseResult>;
    resolve: (result: VoiceCloseResult) => void;
    reject: (error: VoiceClientError) => void;
    timeout: number;
  } | null = null;

  constructor(options: VoiceConnectionOptions) { this.options = options; }

  private handlePageHide = () => this.disconnect();

  async connect() {
    if (this.attemptActive) throw new VoiceClientError('connection_in_progress', '连接正在建立中');
    if (this.socket) this.disconnect();
    this.manual = false;
    this.replaced = false;
    this.reconnectAttempt = 0;
    this.graceful = false;
    this.seen.clear();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    window.addEventListener('pagehide', this.handlePageHide);
    await this.open(false);
  }

  private async open(reconnecting: boolean) {
    const generation = ++this.generation;
    this.attemptActive = true;
    this.lastSequence = 0;
    this.retryOnClose = false;
    this.requestedRetryAfterMs = 0;
    this.stopHeartbeat();
    this.options.onState?.(reconnecting ? 'reconnecting' : 'connecting');
    try {
      const key = await this.options.getConnectionKey();
      if (generation !== this.generation || this.manual) return;
      const socket = (this.options.webSocketFactory || ((url) => new WebSocket(url)))(buildLocalVoiceSocketUrl(key));
      this.socket = socket;
      socket.addEventListener('message', (message) => this.handleMessage(generation, message));
      socket.addEventListener('close', (event) => this.handleClose(generation, event));
      socket.addEventListener('error', () => {
        if (generation !== this.generation) return;
        this.ready = false;
        this.attemptActive = false;
        this.stopHeartbeat();
        if (!this.manual) this.scheduleReconnect();
      });
    } catch {
      this.attemptActive = false;
      if (!this.manual) this.scheduleReconnect();
    }
  }

  private handleMessage(generation: number, message: MessageEvent) {
    if (generation !== this.generation) return;
    let event: unknown;
    try { event = JSON.parse(String(message.data)); } catch {
      this.options.onError?.(new VoiceClientError('invalid_server_event', '收到无效的服务端事件'));
      return;
    }
    if (!isValidVoiceServerEvent(event, this.options.conversationId) || event.sequence <= this.lastSequence || this.seen.has(event.event_id)) return;
    this.lastSequence = event.sequence;
    this.seen.add(event.event_id);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    if (event.type === 'voice.ready') {
      this.ready = true;
      this.attemptActive = false;
      this.reconnectAttempt = 0;
      this.graceful = (event.payload.capabilities as Record<string, unknown> | undefined)?.graceful_close === true;
      this.startHeartbeat();
    }
    if (event.type === 'voice.replaced') { this.replaced = true; this.ready = false; }
    if (event.type === 'error' && (event.payload.retryable === true || event.payload.code === 'service_restarting')) {
      this.retryOnClose = true;
      const retryAfterMs = Number(event.payload.retry_after_ms);
      this.requestedRetryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
    }
    this.options.onEvent?.(event);
    if (event.type === 'connection.closed' && this.pendingClose) {
      const requestId = event.payload.request_id;
      const outcome = event.payload.outcome;
      if (requestId === this.pendingClose.requestId && typeof outcome === 'string' && outcome) {
        const pending = this.pendingClose;
        this.pendingClose = null;
        window.clearTimeout(pending.timeout);
        this.manual = true;
        this.ready = false;
        this.stopHeartbeat();
        pending.resolve({ outcome });
      }
    }
  }

  private handleClose(generation: number, event: CloseEvent) {
    if (generation !== this.generation) return;
    this.ready = false;
    this.attemptActive = false;
    this.socket = null;
    this.stopHeartbeat();
    if (this.pendingClose) {
      const pending = this.pendingClose;
      this.pendingClose = null;
      window.clearTimeout(pending.timeout);
      pending.reject(new VoiceClientError('graceful_close_failed', '语音连接未能安全结束'));
    }
    if (this.replaced) this.options.onState?.('replaced');
    else if (!this.manual && (this.retryOnClose || RETRY_CODES.has(event.code))) this.scheduleReconnect();
    else this.options.onState?.('disconnected');
  }

  private scheduleReconnect() {
    if (this.manual || this.replaced || this.reconnectTimer !== null) return;
    if (this.reconnectAttempt >= RETRY_DELAYS.length) {
      this.options.onError?.(new VoiceClientError('realtime_connection_failed', '实时连接恢复失败'));
      this.options.onState?.('disconnected');
      return;
    }
    const attempt = ++this.reconnectAttempt;
    const delay = Math.max(RETRY_DELAYS[attempt - 1], this.requestedRetryAfterMs);
    this.options.onReconnect?.(attempt, RETRY_DELAYS.length);
    this.options.onState?.('reconnecting');
    const generation = this.generation;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.prepareReconnect(generation);
    }, delay);
  }

  private async prepareReconnect(generation: number) {
    if (this.manual || this.replaced || generation !== this.generation) return;
    try { await this.options.beforeReconnect?.(); } catch {
      if (!this.manual && !this.replaced && generation === this.generation) this.scheduleReconnect();
      return;
    }
    if (!this.manual && !this.replaced && generation === this.generation) await this.open(true);
  }

  send(type: string, payload: Record<string, unknown> = {}) {
    if ((type === 'audio.append' || type === 'text.message') && !this.ready) return false;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ version: VERSION, type, payload }));
    return true;
  }

  closeGracefully(): Promise<VoiceCloseResult> {
    if (this.pendingClose) return this.pendingClose.promise;
    if (!this.graceful || !this.ready) {
      this.disconnect();
      return Promise.resolve({ outcome: 'unsupported' });
    }
    const requestId = crypto.randomUUID();
    let resolveClose!: (result: VoiceCloseResult) => void;
    let rejectClose!: (error: VoiceClientError) => void;
    const promise = new Promise<VoiceCloseResult>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    const timeout = window.setTimeout(() => {
      const pending = this.pendingClose;
      if (!pending || pending.requestId !== requestId) return;
      this.pendingClose = null;
      pending.reject(new VoiceClientError('graceful_close_timeout', '语音连接结束确认超时'));
      this.disconnect();
    }, GRACEFUL_CLOSE_TIMEOUT_MS);
    this.pendingClose = { requestId, promise, resolve: resolveClose, reject: rejectClose, timeout };
    this.manual = true;
    this.stopHeartbeat();
    if (!this.send('connection.close', { request_id: requestId })) {
      window.clearTimeout(timeout);
      this.pendingClose = null;
      this.disconnect();
      rejectClose(new VoiceClientError('graceful_close_failed', '语音连接未能安全结束'));
    }
    return promise;
  }

  disconnect() {
    this.manual = true;
    this.generation += 1;
    this.ready = false;
    this.attemptActive = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    if (this.pendingClose) {
      const pending = this.pendingClose;
      this.pendingClose = null;
      window.clearTimeout(pending.timeout);
      pending.reject(new VoiceClientError('graceful_close_cancelled', '语音连接已终止'));
    }
    window.removeEventListener('pagehide', this.handlePageHide);
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'voice disconnect');
    this.socket = null;
  }

  private clearReconnectTimer() { if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  private startHeartbeat() { this.stopHeartbeat(); this.heartbeat = window.setInterval(() => this.send('ping'), HEARTBEAT_INTERVAL_MS); }
  private stopHeartbeat() { if (this.heartbeat !== null) window.clearInterval(this.heartbeat); this.heartbeat = null; }
}
