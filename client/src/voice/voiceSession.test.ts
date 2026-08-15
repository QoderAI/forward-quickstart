import { describe, expect, test } from 'vitest';
import type { ForwardSession } from '../forwardApi';
import { isVoiceSession } from './voiceSession';

describe('isVoiceSession', () => {
  test('narrows voice-gateway metadata to a required conversation id', () => {
    const voice = { id: 'sess_voice', metadata: { source: 'voice-gateway', conversation_id: 'conv_1' } } as ForwardSession;
    expect(isVoiceSession(voice)).toBe(true);
    if (isVoiceSession(voice)) expect(voice.metadata.conversation_id).toBe('conv_1');
    expect(isVoiceSession({ ...voice, metadata: { source: 'forward-quickstart' } })).toBe(false);
  });
});
