import { describe, expect, test } from 'vitest';
import { voiceAvailabilityFrom } from './useVoiceAvailability';

describe('voice availability', () => {
  test('maps template config to an enabled or disabled entry', () => {
    expect(voiceAvailabilityFrom(true)).toEqual({ status: 'enabled', enabled: true, reason: '' });
    expect(voiceAvailabilityFrom(false)).toMatchObject({ status: 'disabled', enabled: false });
    expect(voiceAvailabilityFrom(true, false)).toEqual({ status: 'disabled', enabled: false, reason: 'Voice 仅支持本地运行' });
  });
});
