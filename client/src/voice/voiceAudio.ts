const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;
const MAX_SAMPLES = 4096;

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function floatToPcm16(samples: Float32Array, sourceRate: number, targetRate = INPUT_RATE): Int16Array {
  const ratio = sourceRate / targetRate;
  const result = new Int16Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let i = 0; i < result.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end && j < samples.length; j += 1) sum += samples[j];
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    result[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return result;
}

export function pcm16Frames(samples: Float32Array, sourceRate: number): string[] {
  const pcm = floatToPcm16(samples, sourceRate);
  const result: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += MAX_SAMPLES) {
    const frame = pcm.subarray(offset, offset + MAX_SAMPLES);
    result.push(toBase64(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)));
  }
  return result;
}

export function base64Pcm16ToFloat(audio: string): Float32Array<ArrayBuffer> {
  const binary = atob(audio);
  if (binary.length % 2 !== 0) throw new Error('Invalid PCM16 audio');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const output = new Float32Array(new ArrayBuffer(binary.length * 2));
  for (let i = 0; i < output.length; i += 1) output[i] = view.getInt16(i * 2, true) / 0x8000;
  return output;
}

export class MicrophoneCapture {
  private generation = 0;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  async start(onFrame: (frame: string) => void): Promise<void> {
    if (this.stream) return;
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => pcm16Frames(event.inputBuffer.getChannelData(0), context.sampleRate).forEach(onFrame);
    source.connect(processor);
    processor.connect(context.destination);
    this.stream = stream; this.context = context; this.source = source; this.processor = processor;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const { stream, context, source, processor } = this;
    this.stream = null; this.context = null; this.source = null; this.processor = null;
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
    source?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    await context?.close();
  }
}

export type PlaybackIdentity = { work_id?: string; announcement_id?: string };
export class AudioPlayback {
  private context: AudioContext | null = null;
  private cursor = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private started = false;
  private finished = false;
  private identity: PlaybackIdentity = {};
  private cancelPromise: Promise<void> | null = null;
  private handlers: { onReceipt?: (type: 'playback.started' | 'playback.ended' | 'playback.cancelled', identity: PlaybackIdentity) => void; onState?: (state: 'playing' | 'idle') => void };
  constructor(handlers: { onReceipt?: (type: 'playback.started' | 'playback.ended' | 'playback.cancelled', identity: PlaybackIdentity) => void; onState?: (state: 'playing' | 'idle') => void } = {}) { this.handlers = handlers; }
  get active() { return this.context !== null; }
  begin(identity: PlaybackIdentity = {}) { if (this.context) return; this.context = new AudioContext({ sampleRate: OUTPUT_RATE }); if (this.context.state === 'suspended') void this.context.resume(); this.cursor = this.context.currentTime; this.identity = { ...identity }; this.started = false; this.finished = false; }
  matches(identity: PlaybackIdentity) { return this.identity.work_id === identity.work_id && this.identity.announcement_id === identity.announcement_id; }
  append(audio: string) {
    if (!this.context) this.begin();
    const context = this.context!;
    const samples = base64Pcm16ToFloat(audio);
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE); buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    this.cursor = Math.max(this.cursor, context.currentTime); source.start(this.cursor); this.cursor += buffer.duration; this.sources.add(source);
    if (!this.started) { this.started = true; this.handlers.onState?.('playing'); this.handlers.onReceipt?.('playback.started', this.identity); }
    source.onended = () => { this.sources.delete(source); void this.complete(); };
  }
  finish() { this.finished = true; void this.complete(); }
  async cancel() {
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelPromise = (async () => {
      if (this.started) this.handlers.onReceipt?.('playback.cancelled', { ...this.identity });
      this.sources.forEach((source) => { source.onended = null; try { source.stop(); } catch { /* ended */ } });
      this.sources.clear();
      await this.reset();
    })();
    try { await this.cancelPromise; } finally { this.cancelPromise = null; }
  }
  private async complete() { if (!this.finished || this.sources.size) return; if (this.started) this.handlers.onReceipt?.('playback.ended', this.identity); await this.reset(); }
  private async reset() { const context = this.context; this.context = null; this.identity = {}; this.started = false; this.finished = false; this.handlers.onState?.('idle'); await context?.close(); }
}

export interface VoicePlaybackEvent {
  type: string;
  work_id?: string;
  announcement_id?: string;
  payload: Record<string, unknown>;
}

export interface VoicePlaybackRuntime {
  playback: AudioPlayback | null;
  createPlayback: () => AudioPlayback;
  onStage: (stage: 'speaking' | 'listening') => void;
}

export function handleVoicePlaybackEvent(event: VoicePlaybackEvent, runtime: VoicePlaybackRuntime): boolean {
  if (event.type === 'playback.interrupt') {
    void runtime.playback?.cancel();
    runtime.onStage('listening');
    return true;
  }
  if (event.type === 'voice.state') {
    if (event.payload.state === 'interrupted' || event.payload.state === 'idle') runtime.onStage('listening');
    return true;
  }
  const identity: PlaybackIdentity = {
    ...(event.work_id ? { work_id: event.work_id } : {}),
    ...(event.announcement_id ? { announcement_id: event.announcement_id } : {}),
  };
  if (event.type === 'audio.delta') {
    if (typeof event.payload.audio !== 'string') return true;
    const playback = runtime.playback ?? runtime.createPlayback();
    runtime.playback = playback;
    if (!playback.active) playback.begin(identity);
    if (!playback.matches(identity)) return true;
    playback.append(event.payload.audio);
    runtime.onStage('speaking');
    return true;
  }
  if (event.type === 'audio.done') {
    if (runtime.playback?.active && runtime.playback.matches(identity)) runtime.playback.finish();
    return true;
  }
  return false;
}
