import { describe, expect, test } from 'vitest';
import { channelBindingModes } from './channelBinding';

describe('channelBindingModes', () => {
  test('offers only manual configuration when QR binding is unsupported', () => {
    expect(channelBindingModes({ qrSupport: false, manualSupport: true })).toEqual(['manual']);
  });

  test('offers both supported binding modes', () => {
    expect(channelBindingModes({ qrSupport: true, manualSupport: true })).toEqual(['qr', 'manual']);
  });
});
