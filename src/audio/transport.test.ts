import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createdSources: FakeSource[] = [];
const createdProcessors: FakeSoundTouchNode[] = [];

class FakeParam {
  value = 1;
}

class FakeSource {
  buffer?: AudioBuffer;
  playbackRate = new FakeParam();
  started?: { when: number; offset: number };
  connectTarget?: unknown;
  connect(target: unknown): void { this.connectTarget = target; }
  disconnect(): void {}
  start(when: number, offset: number): void { this.started = { when, offset }; }
  stop(): void {}
}

class FakeSoundTouchNode extends EventTarget {
  playbackRate = new FakeParam();
  pitch = new FakeParam();
  metrics = { underrunCount: 0 };
  stretch?: object;
  constructor() { super();createdProcessors.push(this); }
  connect(): void {}
  disconnect(): void {}
  setStretchParameters(value: object): void { this.stretch = value; }
  static async register(): Promise<void> {}
}

class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = 'running';
  sampleRate = 48_000;
  outputLatency = 0;
  baseLatency = 0;
  destination = {};
  createGain() { return { gain: new FakeParam(), connect() {}, disconnect() {} }; }
  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    createdSources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

vi.mock('@soundtouchjs/audio-worklet', () => ({ SoundTouchNode: FakeSoundTouchNode }));
vi.mock('@soundtouchjs/audio-worklet/processor?url', () => ({ default: '/soundtouch-processor.js' }));
vi.mock('../services/storage', () => ({ loadSongBytes: vi.fn() }));

describe('AudioTransport rate wiring and clock', () => {
  beforeEach(() => {
    createdSources.length = 0;
    createdProcessors.length = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('bypasses calibration at 1x', async () => {
    const { measureDspDelay } = await import('./transport');
    await expect(measureDspDelay(1, 48_000)).resolves.toBe(0);
  });
  it('excludes silent preroll underruns but records every in-song underrun even in practice',async()=>{
    const {AudioTransport}=await import('./transport');const transport=new AudioTransport();
    const internal=transport as unknown as {buffer:AudioBuffer;rate:number;nodeRegistered:boolean};internal.buffer={} as AudioBuffer;internal.rate=1.25;internal.nodeRegistered=true;
    await transport.start(30000,2.5);const processor=createdProcessors.at(-1)!;
    processor.metrics.underrunCount=10;processor.dispatchEvent(new Event('metrics'));expect(transport.metrics().underruns).toBe(0);
    (transport.context as unknown as FakeAudioContext).currentTime=3;processor.metrics.underrunCount=12;processor.dispatchEvent(new Event('metrics'));expect(transport.metrics().underruns).toBe(2);await transport.dispose();
  });

  it.each([0.75, 1, 1.25, 1.5] as const)('uses matching source and processor rates at %sx', async (rate) => {
    const { AudioTransport } = await import('./transport');
    const transport = new AudioTransport();
    const internal = transport as unknown as {
      buffer: AudioBuffer;
      rate: number;
      nodeRegistered: boolean;
      delay: number;
      processor?: FakeSoundTouchNode;
    };
    internal.buffer = {} as AudioBuffer;
    internal.rate = rate;
    internal.nodeRegistered = rate !== 1;
    internal.delay = rate === 1 ? 0 : 0.12;

    await transport.start(2_000, 2.5);
    const source = createdSources.at(-1)!;
    expect(source.playbackRate.value).toBe(rate);
    expect(source.started).toEqual({ when: 2.5, offset: 2 });
    if (rate === 1) {
      expect(internal.processor).toBeUndefined();
    } else {
      expect(internal.processor?.playbackRate.value).toBe(rate);
      expect(internal.processor?.pitch.value).toBe(1);
      expect(internal.processor?.stretch).toEqual({ sequenceMs: 40, seekWindowMs: 15, overlapMs: 8, quickSeek: true });
    }

    (transport.context as unknown as FakeAudioContext).currentTime = 3.5;
    const expected = 2_000 + (1 - internal.delay) * rate * 1_000;
    expect(transport.sourceTimeAt()).toBeCloseTo(expected, 2);
    await transport.dispose();
  });
});
