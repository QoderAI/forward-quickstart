import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AudioPlayback, base64Pcm16ToFloat, floatToPcm16, handleVoicePlaybackEvent, pcm16Frames, type VoicePlaybackRuntime } from './voiceAudio';

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  resume = vi.fn();
  close = vi.fn(async () => undefined);
  createBuffer = vi.fn(() => ({ duration: 1 / 24_000, copyToChannel: vi.fn() }));
  createBufferSource = vi.fn(() => {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  });
  constructor() { FakeAudioContext.instances.push(this); }
}

describe('voice audio conversion', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => vi.unstubAllGlobals());

  test('clamps float samples to PCM16', () => {
    expect(Array.from(floatToPcm16(new Float32Array([-2, -1, 0, 1, 2]), 16_000))).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
  test('splits and decodes frames', () => {
    const frames = pcm16Frames(new Float32Array(5000).fill(0.5), 16_000);
    expect(frames).toHaveLength(2);
    expect(base64Pcm16ToFloat(frames[0])).toHaveLength(4096);
    expect(() => base64Pcm16ToFloat('AQ==')).toThrow('Invalid PCM16 audio');
  });

  test('stops queued browser audio when the gateway interrupts playback', async () => {
    const receipts: string[] = [];
    const stages: string[] = [];
    const runtime: VoicePlaybackRuntime = {
      playback: null,
      createPlayback: () => new AudioPlayback({ onReceipt: (type) => receipts.push(type) }),
      onStage: (stage) => stages.push(stage),
    };

    handleVoicePlaybackEvent({ type: 'audio.delta', work_id: 'work-1', payload: { audio: 'AAA=' } }, runtime);
    expect(FakeAudioContext.instances[0].sources[0].stop).not.toHaveBeenCalled();
    handleVoicePlaybackEvent({ type: 'playback.interrupt', payload: { reason: 'speech_started' } }, runtime);
    await vi.waitFor(() => expect(FakeAudioContext.instances[0].sources[0].stop).toHaveBeenCalledOnce());

    expect(receipts).toEqual(['playback.started', 'playback.cancelled']);
    expect(stages).toEqual(['speaking', 'listening']);
  });

  test('does not replace an active announcement with mismatched audio', () => {
    const runtime: VoicePlaybackRuntime = {
      playback: null,
      createPlayback: () => new AudioPlayback(),
      onStage: vi.fn(),
    };

    handleVoicePlaybackEvent({ type: 'audio.delta', work_id: 'work-1', announcement_id: 'ann-1', payload: { audio: 'AAA=' } }, runtime);
    handleVoicePlaybackEvent({ type: 'audio.delta', work_id: 'work-1', announcement_id: 'ann-2', payload: { audio: 'AAA=' } }, runtime);

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].createBufferSource).toHaveBeenCalledOnce();
  });
});
