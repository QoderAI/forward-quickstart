import type { ForwardSession } from '../forwardApi';

export type VoiceSession = ForwardSession & {
  metadata: Record<string, unknown> & {
    source: 'voice-gateway';
    conversation_id: string;
  };
};

export function isVoiceSession(session: ForwardSession): session is VoiceSession {
  return session.metadata?.source === 'voice-gateway';
}
