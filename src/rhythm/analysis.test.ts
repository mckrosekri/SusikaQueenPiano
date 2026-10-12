import { describe, expect, it } from 'vitest';

import { analyzePCM } from './analysis';

function pulseTrack(
  bpm: number,
  durationSeconds: number,
  sampleRate = 44_100,
  syncopated = false,
): Float32Array {
  const samples = new Float32Array(Math.round(durationSeconds * sampleRate));
  const beatSamples = (60 / bpm) * sampleRate;
  const clickLength = Math.round(sampleRate * 0.012);
  const placeClick = (start: number, gain: number): void => {
    for (let offset = 0; offset < clickLength && start + offset < samples.length; offset += 1) {
      const envelope = Math.exp(-offset / (sampleRate * 0.0025));
      const alternating = offset % 2 === 0 ? 1 : -1;
      samples[start + offset] += alternating * envelope * gain;
    }
  };
  for (let beat = 0; beat * beatSamples < samples.length; beat += 1) {
    placeClick(Math.round(beat * beatSamples), beat % 4 === 0 ? 0.95 : 0.7);
    if (syncopated && beat % 2 === 0) placeClick(Math.round((beat + 0.66) * beatSamples), 0.42);
  }
  return samples;
}

function addTone(
  samples: Float32Array,
  sampleRate: number,
  startSeconds: number,
  holdEndSeconds: number,
  frequency: number,
  gain = 0.45,
  releaseSeconds = 0,
): void {
  const start = Math.round(startSeconds * sampleRate);
  const releaseEnd = Math.min(samples.length, Math.round((holdEndSeconds + releaseSeconds) * sampleRate));
  const attackSamples = Math.max(1, Math.round(sampleRate * 0.012));
  const holdEnd = Math.round(holdEndSeconds * sampleRate);
  for (let index = start; index < releaseEnd; index += 1) {
    const attack = Math.min(1, (index - start) / attackSamples);
    const release = index < holdEnd || releaseSeconds === 0
      ? 1
      : Math.max(0, 1 - (index - holdEnd) / (releaseSeconds * sampleRate));
    samples[index] += Math.sin((2 * Math.PI * frequency * (index - start)) / sampleRate) * gain * attack * release;
  }
}

function addClick(samples: Float32Array, sampleRate: number, timeSeconds: number, gain = 0.9): void {
  const start = Math.round(timeSeconds * sampleRate);
  const length = Math.round(sampleRate * 0.01);
  for (let offset = 0; offset < length && start + offset < samples.length; offset += 1) {
    samples[start + offset] += (offset % 2 ? -1 : 1) * gain * Math.exp(-offset / (sampleRate * 0.0018));
  }
}

function deterministicNoise(sampleCount: number, gain: number): Float32Array {
  const samples = new Float32Array(sampleCount);
  let state = 0x1234abcd;
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    samples[index] = ((state / 0xffff_ffff) * 2 - 1) * gain;
  }
  return samples;
}

describe('analyzePCM', () => {
  it('detects regular click onsets and their beat tempo deterministically', () => {
    const pcm = pulseTrack(120, 10);
    const progress: number[] = [];
    const first = analyzePCM(pcm, 44_100, 'regular-120', (value) => progress.push(value));
    const second = analyzePCM(pcm, 44_100, 'regular-120');

    expect(first).toEqual(second);
    expect(first.bpm).toBeGreaterThanOrEqual(117);
    expect(first.bpm).toBeLessThanOrEqual(123);
    expect(first.onsets.length).toBeGreaterThanOrEqual(15);
    expect(first.beatsMs.length).toBeGreaterThanOrEqual(18);
    expect(first.activity!.length).toBeGreaterThanOrEqual(15);
    expect(first.confidence).toBeGreaterThan(0.3);
    expect(first.intensity).toBeGreaterThan(0);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  });

  it('keeps the main pulse for syncopated material while retaining extra onsets', () => {
    const regular = analyzePCM(pulseTrack(100, 12), 44_100, 'regular-100');
    const syncopated = analyzePCM(pulseTrack(100, 12, 44_100, true), 44_100, 'syncopated-100');

    expect(syncopated.bpm).toBeGreaterThanOrEqual(96);
    expect(syncopated.bpm).toBeLessThanOrEqual(104);
    expect(syncopated.onsets.length).toBeGreaterThan(regular.onsets.length);
  });

  it('reports silence conservatively', () => {
    const result = analyzePCM(new Float32Array(44_100 * 3), 44_100, 'silent');

    expect(result.onsets).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.intensity).toBe(0);
    expect(result.warnings).toContain('silence_or_no_onsets');
    expect(result.warnings).toContain('low_tempo_confidence');
  });

  it('sanitizes corrupt samples and never leaks their values into output', () => {
    const pcm = pulseTrack(120, 4);
    pcm[1] = Number.NaN;
    pcm[2] = Number.POSITIVE_INFINITY;
    const result = analyzePCM(pcm, 44_100, 'corrupt');

    expect(result.warnings).toContain('non_finite_samples_replaced');
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
    expect(result.energy.every(Number.isFinite)).toBe(true);
  });

  it('rejects an invalid sample rate without including PCM data', () => {
    expect(() => analyzePCM(new Float32Array([0.1234567]), 0, 'invalid')).toThrow('invalid sample rate');
    try {
      analyzePCM(new Float32Array([0.1234567]), 0, 'invalid');
    } catch (error) {
      expect(String(error)).not.toContain('0.1234567');
    }
  });

  it('measures a held tonal region through its amplitude release', () => {
    const sampleRate = 44_100;
    const pcm = new Float32Array(sampleRate * 4);
    addTone(pcm, sampleRate, 0.5, 2.0, 440, 0.48, 0.5);
    const result = analyzePCM(pcm, sampleRate, 'held-tone-release');

    expect(result.sustains).toHaveLength(1);
    expect(result.sustains![0].startMs).toBeGreaterThanOrEqual(470);
    expect(result.sustains![0].startMs).toBeLessThanOrEqual(540);
    expect(result.sustains![0].endMs).toBeGreaterThanOrEqual(2_350);
    expect(result.sustains![0].endMs).toBeLessThanOrEqual(2_550);
    expect(result.sustains![0].confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('does not mislabel clicks or broadband noise as sustained tones', () => {
    const sampleRate = 44_100;
    const clicks = pulseTrack(120, 4, sampleRate);
    const noise = new Float32Array(sampleRate * 4);
    noise.set(deterministicNoise(sampleRate * 2, 0.22), sampleRate);

    expect(analyzePCM(clicks, sampleRate, 'clicks').sustains).toEqual([]);
    expect(analyzePCM(noise, sampleRate, 'noise').sustains).toEqual([]);
  });

  it('ends and restarts tonal evidence across a pitch change and a repeated attack', () => {
    const sampleRate = 44_100;
    const changed = new Float32Array(sampleRate * 3);
    addTone(changed, sampleRate, 0.4, 1.25, 330);
    addTone(changed, sampleRate, 1.25, 2.2, 523.25);
    const changedResult = analyzePCM(changed, sampleRate, 'pitch-change');

    expect(changedResult.sustains).toHaveLength(2);
    expect(changedResult.sustains![0].endMs).toBeGreaterThanOrEqual(1_180);
    expect(changedResult.sustains![0].endMs).toBeLessThanOrEqual(1_330);
    expect(changedResult.sustains![1].startMs).toBeGreaterThanOrEqual(1_210);
    expect(changedResult.sustains![1].startMs).toBeLessThanOrEqual(1_310);
    expect(changedResult.sustains![1].startMs).toBeGreaterThanOrEqual(changedResult.sustains![0].endMs);

    const repeated = new Float32Array(sampleRate * 3);
    addTone(repeated, sampleRate, 0.4, 1.25, 440);
    addTone(repeated, sampleRate, 1.25, 2.2, 440);
    const repeatedResult = analyzePCM(repeated, sampleRate, 'repeated-attack');
    expect(repeatedResult.sustains).toHaveLength(2);
  });

  it('reports audible sections and localizes isolated attacks without filling silence', () => {
    const sampleRate = 44_100;
    const pcm = new Float32Array(sampleRate * 5);
    addTone(pcm, sampleRate, 1, 1.8, 392);
    const noise = deterministicNoise(Math.round(sampleRate * 0.6), 0.12);
    pcm.set(noise, Math.round(sampleRate * 3));
    addClick(pcm, sampleRate, 3.2);
    const result = analyzePCM(pcm, sampleRate, 'activity-sections');

    expect(result.activity).toHaveLength(2);
    expect(result.activity![0].startMs).toBeGreaterThanOrEqual(980);
    expect(result.activity![0].endMs).toBeLessThanOrEqual(1_840);
    expect(result.activity![1].startMs).toBeGreaterThanOrEqual(2_980);
    expect(result.activity![1].endMs).toBeLessThanOrEqual(3_640);
    expect(result.onsets.some((onset) => Math.abs(onset.timeMs - 1_000) <= 25)).toBe(true);

    const attacks = new Float32Array(sampleRate * 2);
    addClick(attacks, sampleRate, 0.75);
    addClick(attacks, sampleRate, 1.5);
    const attackResult = analyzePCM(attacks, sampleRate, 'localized-attacks');
    expect(attackResult.onsets.some((onset) => Math.abs(onset.timeMs - 750) <= 25)).toBe(true);
    expect(attackResult.onsets.some((onset) => Math.abs(onset.timeMs - 1_500) <= 25)).toBe(true);
  });
});
