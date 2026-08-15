import { useCallback, useEffect, useRef, useState } from 'react';
import type { ForwardContext } from '../forwardApi';
import { AudioPlayback, handleVoicePlaybackEvent, MicrophoneCapture, type VoicePlaybackRuntime } from './voiceAudio';
import { createRealtimeConversation, getCompleteRealtimeConversationHistory, requestVoiceConnectionKey } from './voiceApi';
import { VoiceConnection, type VoiceServerEvent } from './voiceConnection';
import {
  applyVoiceTimelineEvent,
  createVoiceTimelineState,
  createVoiceTimelineStateFromEntries,
  projectVoiceHistory,
  removeTimelineEntry,
  selectTimelineEntries,
  upsertLocalUserTextDraft,
  type TimelineEntry,
  type VoiceTimelineState,
} from './voiceTimeline';

export type VoiceStage = 'idle' | 'loading-history' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting' | 'ending' | 'ended' | 'error';

interface VoiceSessionOptions {
  ctx: ForwardContext;
  identityId: string;
  templateId: string;
  initialConversationId: string | null;
  autoStart: boolean;
  launchKey: number;
  onConversationCreated: (id: string) => void;
  onStartFailed: (message: string) => void;
}

const activeWorkTypes = new Set(['work.accepted', 'work.queued', 'work.started', 'work.running', 'work.progress', 'work.milestone']);
const terminalWorkTypes = new Set(['work.completed', 'work.failed', 'work.cancelled']);
const hiddenErrorCodes = new Set(['service_restarting', 'provider_unavailable', 'invalid_playback_receipt']);
const MAX_CLIENT_TEXT_BYTES = 16 * 1024;

export function useVoiceSession(options: VoiceSessionOptions) {
  const [conversationId, setConversationId] = useState(options.initialConversationId);
  const [stage, setStage] = useState<VoiceStage>(options.initialConversationId ? 'loading-history' : 'idle');
  const [timelineState, setTimelineState] = useState<VoiceTimelineState>(createVoiceTimelineState());
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [microphoneWarning, setMicrophoneWarning] = useState<string | null>(null);
  const mutedRef = useRef(muted);
  const stageRef = useRef(stage);
  const connection = useRef<VoiceConnection | null>(null);
  const microphone = useRef(new MicrophoneCapture());
  const playback = useRef<AudioPlayback | null>(null);
  const generation = useRef(0);
  const createIdempotencyKey = useRef(crypto.randomUUID());

  useEffect(() => { mutedRef.current = muted; stageRef.current = stage; }, [muted, stage]);

  const loadHistory = useCallback(async (id: string) => {
    const history = await getCompleteRealtimeConversationHistory(options.ctx, id, { limit: 100, types: 'message,work' });
    setTimelineState(createVoiceTimelineStateFromEntries(projectVoiceHistory(history.events)));
    return history;
  }, [options.ctx]);

  const createPlayback = useCallback(() => new AudioPlayback({
    onReceipt: (type, identity) => connection.current?.send(type, identity),
    onState: (value) => {
      if (value === 'idle') {
        setStage((current) => current === 'speaking' ? 'listening' : current);
      }
    },
  }), []);

  const handleEvent = useCallback((event: VoiceServerEvent) => {
    const runtime: VoicePlaybackRuntime = {
      playback: playback.current,
      createPlayback,
      onStage: (nextStage) => setStage((current) => ['ending', 'ended', 'error'].includes(current) ? current : nextStage),
    };
    if (handleVoicePlaybackEvent(event, runtime)) {
      playback.current = runtime.playback;
      return;
    }
    if (event.type === 'voice.ready') {
      setError(null);
      setStage('listening');
      return;
    }
    if (event.type === 'voice.replaced') {
      setError('该语音会话已被其他连接接管');
      setStage('error');
      void microphone.current.stop();
      void playback.current?.cancel();
      connection.current?.disconnect();
      return;
    }
    if (event.type === 'error') {
      const code = typeof event.payload.code === 'string' ? event.payload.code : 'unknown';
      if (!hiddenErrorCodes.has(code)) setError(`${String(event.payload.message || '语音服务异常')}（${code}）`);
      return;
    }
    if (event.type.startsWith('transcript.') || event.type.startsWith('work.')) {
      setTimelineState((state) => applyVoiceTimelineEvent(state, event));
      if (activeWorkTypes.has(event.type)) setStage((current) => current === 'speaking' ? current : 'thinking');
      if (terminalWorkTypes.has(event.type)) setStage((current) => current === 'speaking' ? current : 'listening');
    }
  }, [createPlayback]);

  const connect = useCallback(async (id: string) => {
    connection.current?.disconnect();
    const next = new VoiceConnection({
      conversationId: id,
      getConnectionKey: async () => (await requestVoiceConnectionKey(options.ctx, id)).connection_key,
      beforeReconnect: async () => {
        setStage('reconnecting');
        await playback.current?.cancel();
        await loadHistory(id);
      },
      onEvent: handleEvent,
      onState: (value) => {
        if (value === 'reconnecting') setStage('reconnecting');
        if (value === 'replaced') {
          setStage('error');
          setError('该语音会话已被其他连接接管');
        }
        if (value === 'disconnected' && !['ending', 'ended', 'error'].includes(stageRef.current)) {
          setStage('error');
          setError('语音连接已断开');
          void microphone.current.stop();
          void playback.current?.cancel();
        }
      },
      onError: (value) => { setStage('error'); setError(value.message); },
    });
    connection.current = next;
    setStage('connecting');
    await next.connect();
  }, [handleEvent, loadHistory, options.ctx]);

  const startMicrophone = useCallback(async () => {
    setMicrophoneWarning(null);
    try {
      await microphone.current.start((audio) => {
        if (!mutedRef.current && connection.current?.ready && stageRef.current !== 'reconnecting') {
          connection.current.send('audio.append', { audio });
        }
      });
    } catch {
      setMicrophoneWarning('麦克风不可用，仍可使用文字对话');
    }
  }, []);

  const startNew = useCallback(async () => {
    const run = ++generation.current;
    setError(null);
    setConversationId(null);
    setTimelineState(createVoiceTimelineState());
    await startMicrophone();
    if (run !== generation.current) return;
    try {
      const created = await createRealtimeConversation(options.ctx, {
        templateId: options.templateId,
        identityId: options.identityId,
        title: 'Voice Session',
        idempotencyKey: createIdempotencyKey.current,
      });
      if (run !== generation.current) return;
      setConversationId(created.id);
      options.onConversationCreated(created.id);
      await connect(created.id);
    } catch (value) {
      if (run !== generation.current) return;
      await microphone.current.stop();
      const message = value instanceof Error ? value.message : String(value);
      setStage('error');
      setError(message);
      options.onStartFailed(message);
    }
  }, [connect, options, startMicrophone]);

  useEffect(() => {
    const mic = microphone.current;
    const id = options.initialConversationId;
    void Promise.resolve().then(async () => {
      if (id) {
        setConversationId(id);
        setStage('loading-history');
        await loadHistory(id).then(() => setStage('ended')).catch((value) => {
          setStage('error');
          setError(value instanceof Error ? value.message : String(value));
        });
      } else if (options.autoStart) {
        await startNew();
      }
    });
    return () => {
      generation.current += 1;
      connection.current?.disconnect();
      void mic.stop();
      void playback.current?.cancel();
    };
    // launchKey remounts one Voice lifecycle; other values are captured for that lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.launchKey]);

  const sendText = useCallback((text: string) => {
    const value = text.trim();
    const activeConnection = connection.current;
    if (!value || !activeConnection?.ready) return false;
    if (new TextEncoder().encode(value).byteLength > MAX_CLIENT_TEXT_BYTES) {
      setError('文字消息过长，请缩短后重试');
      return false;
    }
    setError(null);
    const id = `local-${crypto.randomUUID()}`;
    setTimelineState((state) => upsertLocalUserTextDraft(state, id, value, true));
    activeConnection.send('interrupt', { reason: 'text_message' });
    void playback.current?.cancel();
    const sent = activeConnection.send('text.message', { text: value });
    setTimelineState((state) => sent
      ? upsertLocalUserTextDraft(state, id, value, false)
      : removeTimelineEntry(state, id));
    if (!sent) setError('消息发送失败，请稍后重试');
    return sent;
  }, []);

  const end = useCallback(async () => {
    const activeConnection = connection.current;
    setStage('ending');
    await Promise.allSettled([microphone.current.stop(), playback.current?.cancel()]);
    try {
      await activeConnection?.closeGracefully();
      if (conversationId) await loadHistory(conversationId);
    } catch (value) {
      setError(value instanceof Error ? value.message : '语音连接未能安全结束');
    } finally {
      if (connection.current === activeConnection) connection.current = null;
      activeConnection?.disconnect();
      playback.current = null;
      setStage('ended');
    }
  }, [conversationId, loadHistory]);

  const continueConversation = useCallback(async () => {
    if (!conversationId) return;
    setError(null);
    await startMicrophone();
    await connect(conversationId);
  }, [connect, conversationId, startMicrophone]);

  return {
    conversationId,
    stage,
    timeline: selectTimelineEntries(timelineState) as TimelineEntry[],
    muted,
    setMuted,
    error,
    microphoneWarning,
    startNew,
    continueConversation,
    sendText,
    end,
  };
}
