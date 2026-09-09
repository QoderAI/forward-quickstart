import { describe, expect, test } from 'vitest';
import { voiceAvailabilityFrom } from './useVoiceAvailability';

describe('voice availability', () => {
  test('maps local proxy capability without a template feature flag', () => {
    expect(voiceAvailabilityFrom(true)).toEqual({ status: 'enabled', enabled: true, reason: '' });
    expect(voiceAvailabilityFrom(false)).toMatchObject({ status: 'disabled', enabled: false });
    expect(voiceAvailabilityFrom(false)).toEqual({ status: 'disabled', enabled: false, reason: '当前部署未启用语音代理' });
  });
});
