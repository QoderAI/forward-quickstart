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
  gain = { gain: { value: 1, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  createGain = vi.fn(() => this.gain);
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


describe('speaker mute', () => {
  beforeEach(() => { FakeAudioContext.instances = []; vi.stubGlobal('AudioContext', FakeAudioContext); });
  afterEach(() => vi.unstubAllGlobals());

  test('mutes and unmutes queued audio without stopping playback or changing receipts', async () => {
    const receipt = vi.fn();
    const playback = new AudioPlayback({ onReceipt: receipt });
    playback.begin({ work_id: 'w1' });
    playback.append('AAA=');
    const context = FakeAudioContext.instances[0];
    playback.setMuted(true);
    expect(context.gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
    playback.append('AAA=');
    playback.setMuted(false);
    expect(context.gain.gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0);
    expect(context.sources[1].start).toHaveBeenCalledWith(1 / 24_000);
    for (const source of context.sources) {
      expect(source.connect).toHaveBeenCalledWith(context.gain);
      expect(source.stop).not.toHaveBeenCalled();
    }
    expect(receipt.mock.calls.map(call => call[0])).toEqual(['playback.started']);
    playback.finish();
    context.sources.forEach(source => source.onended?.());
    expect(receipt.mock.calls.map(call => call[0])).toEqual(['playback.started', 'playback.ended']);
    await playback.cancel();
  });

  test('retains mute across audio segments including mute before the first frame', async () => {
    const playback = new AudioPlayback();
    playback.setMuted(true);
    playback.append('AAA=');
    expect(FakeAudioContext.instances[0].gain.gain.value).toBe(0);
    await playback.cancel();
    playback.append('AAA=');
    expect(FakeAudioContext.instances[1].gain.gain.value).toBe(0);
    playback.setMuted(false);
    expect(FakeAudioContext.instances[1].gain.gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0);
    await playback.cancel();
  });
});
