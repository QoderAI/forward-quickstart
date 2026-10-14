export const readyPayload = {
  config: { audio: { output: { voice: 'longanqian' } } }, provider: 'fixture',
  input_audio: { format: 'pcm16', sample_rate: 16000, channels: 1 },
  output_audio: { format: 'pcm16', sample_rate: 24000, channels: 1 },
  capabilities: { graceful_close: true },
};
export function voiceEvent(conversationId: string, sequence: number, type: string, payload: Record<string, unknown>) {
  return { version: 'voice.realtime.v1', type, payload, event_id: `evt_${sequence}`, sequence,
    conversation_id: conversationId, timestamp: '2026-10-13T00:00:00.123456789Z' };
}
