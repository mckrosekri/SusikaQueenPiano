import type { ActivityRegion, BeatAnalysis, Onset, SustainRegion } from '../types';

export const ANALYSIS_VERSION = 'afterbeat-analysis-v2';

const TARGET_SAMPLE_RATE = 22_050;
const FFT_SIZE = 1_024;
const HOP_SIZE = 256;
const MIN_BPM = 60;
const MAX_BPM = 200;
const ACTIVITY_BUCKET_MS = 20;

interface PreparedPcm {
  samples: Float32Array;
  sampleRate: number;
  replacedSamples: number;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(fraction) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const mix = index - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function preparePcm(pcm: Float32Array, sampleRate: number): PreparedPcm {
  if (!(pcm instanceof Float32Array)) {
    throw new TypeError('Audio analysis requires Float32 PCM input.');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 1_000 || sampleRate > 768_000) {
    throw new RangeError('Audio analysis received an invalid sample rate.');
  }

  let replacedSamples = 0;
  const clean = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index];
    if (Number.isFinite(sample)) {
      clean[index] = clamp(sample, -1, 1);
    } else {
      replacedSamples += 1;
    }
  }

  if (sampleRate <= TARGET_SAMPLE_RATE + 1) {
    return { samples: clean, sampleRate, replacedSamples };
  }

  const ratio = sampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(clean.length / ratio));
  const output = new Float32Array(outputLength);

  // A deterministic area average avoids alias-heavy point sampling while staying cheap.
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceStart = outputIndex * ratio;
    const sourceEnd = Math.min(clean.length, (outputIndex + 1) * ratio);
    const first = Math.floor(sourceStart);
    const last = Math.ceil(sourceEnd);
    let total = 0;
    let weight = 0;
    for (let sourceIndex = first; sourceIndex < last; sourceIndex += 1) {
      const overlap = Math.min(sourceEnd, sourceIndex + 1) - Math.max(sourceStart, sourceIndex);
      if (overlap > 0 && sourceIndex < clean.length) {
        total += clean[sourceIndex] * overlap;
        weight += overlap;
      }
    }
    output[outputIndex] = weight > 0 ? total / weight : 0;
  }

  return { samples: output, sampleRate: TARGET_SAMPLE_RATE, replacedSamples };
}

function fftMagnitudes(frame: Float64Array): Float64Array {
  const size = frame.length;
  const real = frame.slice();
  const imaginary = new Float64Array(size);

  let target = 0;
  for (let source = 1; source < size; source += 1) {
    let bit = size >> 1;
    while (target & bit) {
      target ^= bit;
      bit >>= 1;
    }
    target ^= bit;
    if (source < target) {
      [real[source], real[target]] = [real[target], real[source]];
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }

  const magnitudes = new Float64Array(size / 2);
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    magnitudes[bin] = Math.hypot(real[bin], imaginary[bin]);
  }
  return magnitudes;
}

function extractFrames(samples: Float32Array, sampleRate: number, onProgress?: (progress: number) => void): {
  flux: number[];
  rms: number[];
  frameTimesMs: number[];
  tonality: number[];
  stability: number[];
  dominantBins: number[];
} {
  if (samples.length === 0) {
    return { flux: [], rms: [], frameTimesMs: [], tonality: [], stability: [], dominantBins: [] };
  }
  const frameCount = Math.max(1, Math.ceil(Math.max(0, samples.length - FFT_SIZE) / HOP_SIZE) + 1);
  const flux: number[] = [];
  const rms: number[] = [];
  const frameTimesMs: number[] = [];
  const tonality: number[] = [];
  const stability: number[] = [];
  const dominantBins: number[] = [];
  let previous = new Float64Array(FFT_SIZE / 2);
  let previousPower = new Float64Array(FFT_SIZE / 2);
  const firstAudibleBin = Math.max(2, Math.ceil((55 * FFT_SIZE) / sampleRate));
  const lastAudibleBin = Math.min(FFT_SIZE / 2 - 1, Math.floor((6_000 * FFT_SIZE) / sampleRate));

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * HOP_SIZE;
    const frame = new Float64Array(FFT_SIZE);
    let squareSum = 0;
    for (let offset = 0; offset < FFT_SIZE; offset += 1) {
      const sample = start + offset < samples.length ? samples[start + offset] : 0;
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * offset) / (FFT_SIZE - 1));
      frame[offset] = sample * window;
      squareSum += sample * sample;
    }

    const magnitudes = fftMagnitudes(frame);
    const logMagnitudes = new Float64Array(magnitudes.length);
    let positiveDifference = 0;
    let spectralWeight = 0;
    let totalPower = 0;
    let maximumPower = 0;
    let dominantBin = firstAudibleBin;
    let logPowerTotal = 0;
    let currentNorm = 0;
    let previousNorm = 0;
    let crossPower = 0;
    const power = new Float64Array(magnitudes.length);
    for (let bin = firstAudibleBin; bin <= lastAudibleBin; bin += 1) {
      const magnitude = magnitudes[bin];
      const binPower = magnitude * magnitude;
      power[bin] = binPower;
      totalPower += binPower;
      logPowerTotal += Math.log(binPower + 1e-20);
      if (binPower > maximumPower) {
        maximumPower = binPower;
        dominantBin = bin;
      }
      currentNorm += binPower * binPower;
      previousNorm += previousPower[bin] * previousPower[bin];
      crossPower += binPower * previousPower[bin];
    }
    for (let bin = 2; bin < magnitudes.length; bin += 1) {
      logMagnitudes[bin] = Math.log1p(magnitudes[bin]);
      const difference = logMagnitudes[bin] - previous[bin];
      if (difference > 0) {
        const weight = 0.75 + Math.sqrt(bin / magnitudes.length);
        positiveDifference += difference * weight;
        spectralWeight += weight;
      }
    }
    flux.push(spectralWeight > 0 ? positiveDifference / spectralWeight : 0);
    rms.push(Math.sqrt(squareSum / FFT_SIZE));
    frameTimesMs.push(((start + FFT_SIZE / 2) / sampleRate) * 1_000);
    const audibleBins = Math.max(1, lastAudibleBin - firstAudibleBin + 1);
    const arithmeticMean = totalPower / audibleBins;
    const flatness = arithmeticMean > 1e-20
      ? Math.exp(logPowerTotal / audibleBins) / arithmeticMean
      : 1;
    const peakConcentration = maximumPower / Math.max(1e-20, totalPower);
    const flatnessScore = clamp((0.48 - flatness) / 0.44);
    const peakScore = clamp((peakConcentration - 0.025) / 0.24);
    tonality.push(Math.sqrt(flatnessScore * peakScore));
    stability.push(currentNorm > 1e-30 && previousNorm > 1e-30
      ? clamp(crossPower / Math.sqrt(currentNorm * previousNorm))
      : 0);
    dominantBins.push(dominantBin);
    previous.set(logMagnitudes);
    previousPower = power;

    if (frameIndex % 16 === 0) onProgress?.(0.05 + 0.55 * (frameIndex / frameCount));
  }
  return { flux, rms, frameTimesMs, tonality, stability, dominantBins };
}

function localizeAttack(
  samples: Float32Array,
  sampleRate: number,
  spectralCenterMs: number,
): number {
  const halfWindowMs = (FFT_SIZE * 500) / sampleRate;
  const estimateMs = spectralCenterMs - halfWindowMs;
  const bucketSamples = Math.max(1, Math.round(sampleRate * 0.0015));
  const searchStart = Math.max(0, Math.round(((estimateMs - 24) / 1_000) * sampleRate));
  const searchEnd = Math.min(samples.length, Math.round(((estimateMs + 32) / 1_000) * sampleRate));
  if (searchEnd <= searchStart) return Math.max(0, Math.round(estimateMs));

  const envelopes: number[] = [];
  for (let start = searchStart; start < searchEnd; start += bucketSamples) {
    let peak = 0;
    for (let index = start; index < Math.min(searchEnd, start + bucketSamples); index += 1) {
      peak = Math.max(peak, Math.abs(samples[index]));
    }
    envelopes.push(peak);
  }
  const baselineCount = Math.max(1, Math.floor(envelopes.length * 0.3));
  const baseline = percentile(envelopes.slice(0, baselineCount), 0.5);
  const peak = Math.max(...envelopes);
  const threshold = baseline + (peak - baseline) * 0.14;
  if (peak <= Math.max(1e-6, baseline * 1.5)) return Math.max(0, Math.round(estimateMs));
  for (let index = 0; index < envelopes.length; index += 1) {
    if (envelopes[index] >= threshold) {
      return Math.max(0, Math.round(((searchStart + index * bucketSamples) / sampleRate) * 1_000));
    }
  }
  return Math.max(0, Math.round(estimateMs));
}

function detectOnsets(
  flux: number[],
  frameTimesMs: number[],
  samples: Float32Array,
  sampleRate: number,
): Onset[] {
  if (flux.length < 3) return [];
  const floor = percentile(flux, 0.5);
  const upper = percentile(flux, 0.95);
  const maximum = flux.reduce((largest, value) => Math.max(largest, value), 0);
  // A lone tonal attack must not make tiny steady-state FFT jitter look like more attacks.
  const scale = Math.max(1e-9, upper - floor, (maximum - floor) * 0.12);
  const normalized = flux.map((value) => clamp((value - floor) / scale, 0, 10));
  const peaks: Onset[] = [];

  for (let index = 2; index < normalized.length - 2; index += 1) {
    const localStart = Math.max(0, index - 12);
    const localEnd = Math.min(normalized.length, index + 13);
    let localTotal = 0;
    for (let cursor = localStart; cursor < localEnd; cursor += 1) localTotal += normalized[cursor];
    const localMean = localTotal / (localEnd - localStart);
    const value = normalized[index];
    const isPeak = value >= normalized[index - 1] && value > normalized[index + 1];
    if (!isPeak || value < Math.max(0.12, localMean * 1.32 + 0.035)) continue;

    const timeMs = localizeAttack(samples, sampleRate, frameTimesMs[index]);
    const strength = clamp((value - localMean * 0.55) / 4);
    const previous = peaks.at(-1);
    if (previous && timeMs - previous.timeMs < 58) {
      if (strength > previous.strength) peaks[peaks.length - 1] = { timeMs, strength };
    } else {
      peaks.push({ timeMs, strength });
    }
  }
  return peaks;
}

interface TempoEstimate {
  bpm: number;
  phaseMs: number;
  confidence: number;
  ambiguous: boolean;
}

function wrappedDistance(timeMs: number, phaseMs: number, periodMs: number): number {
  const wrapped = ((timeMs - phaseMs) % periodMs + periodMs) % periodMs;
  return Math.min(wrapped, periodMs - wrapped);
}

function tempoScore(onsets: readonly Onset[], bpm: number): { score: number; phaseMs: number } {
  const periodMs = 60_000 / bpm;
  const phaseSteps = 48;
  let bestScore = 0;
  let bestPhase = 0;
  const totalStrength = onsets.reduce((sum, onset) => sum + onset.strength, 0) || 1;

  for (let step = 0; step < phaseSteps; step += 1) {
    const phase = (periodMs * step) / phaseSteps;
    let aligned = 0;
    for (const onset of onsets) {
      const distance = wrappedDistance(onset.timeMs, phase, periodMs);
      const beatFit = Math.exp(-0.5 * (distance / Math.max(26, periodMs * 0.075)) ** 2);
      const halfBeatDistance = Math.abs(distance - periodMs / 2);
      const offBeatFit = Math.exp(-0.5 * (halfBeatDistance / Math.max(22, periodMs * 0.055)) ** 2);
      aligned += onset.strength * (beatFit + 0.18 * offBeatFit);
    }
    const score = aligned / totalStrength;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return { score: bestScore, phaseMs: bestPhase };
}

function intervalConsistency(onsets: readonly Onset[], bpm: number): number {
  const periodMs = 60_000 / bpm;
  let aligned = 0;
  let total = 0;
  for (let first = 0; first < onsets.length; first += 1) {
    for (let second = first + 1; second < Math.min(onsets.length, first + 10); second += 1) {
      const difference = onsets[second].timeMs - onsets[first].timeMs;
      const intervals = Math.round(difference / periodMs);
      if (intervals < 1 || intervals > 8) continue;
      const weight = (onsets[first].strength * onsets[second].strength) / Math.sqrt(intervals);
      const error = Math.abs(difference - intervals * periodMs);
      aligned += weight * Math.exp(-0.5 * (error / Math.max(24, periodMs * 0.055)) ** 2);
      total += weight;
    }
  }
  return total > 0 ? aligned / total : 0;
}

function estimateTempo(onsets: readonly Onset[]): TempoEstimate {
  if (onsets.length < 3) return { bpm: 120, phaseMs: 0, confidence: 0, ambiguous: false };
  const candidates: Array<{ bpm: number; score: number; phaseMs: number }> = [];
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.5) {
    const fit = tempoScore(onsets, bpm);
    const periodicity = intervalConsistency(onsets, bpm);
    // A gentle central-tempo prior resolves exact octave ties without overpowering evidence.
    const prior = 0.94 + 0.06 * Math.exp(-0.5 * ((bpm - 120) / 46) ** 2);
    candidates.push({ bpm, score: (fit.score * 0.62 + periodicity * 0.38) * prior, phaseMs: fit.phaseMs });
  }
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.bpm - 120) - Math.abs(b.bpm - 120));
  const best = candidates[0];
  const unrelated = candidates.find((candidate) => Math.abs(candidate.bpm - best.bpm) > 3) ?? candidates[1];
  const octave = candidates.find((candidate) => {
    const ratio = candidate.bpm / best.bpm;
    return Math.abs(ratio - 2) < 0.025 || Math.abs(ratio - 0.5) < 0.025;
  });
  const margin = unrelated ? clamp((best.score - unrelated.score) / Math.max(0.05, best.score), 0, 1) : 1;
  const absolute = clamp((best.score - 0.28) / 0.62);
  const amount = clamp((onsets.length - 2) / 14);
  const ambiguous = Boolean(octave && octave.score >= best.score * 0.93);
  const confidence = clamp(absolute * (0.45 + 0.3 * amount + 0.25 * Math.sqrt(margin)) * (ambiguous ? 0.86 : 1));
  return { bpm: best.bpm, phaseMs: best.phaseMs, confidence, ambiguous };
}

function buildBeats(durationMs: number, bpm: number, phaseMs: number): number[] {
  const periodMs = 60_000 / bpm;
  let first = phaseMs;
  while (first - periodMs >= 0) first -= periodMs;
  while (first < 0) first += periodMs;
  const beats: number[] = [];
  for (let time = first; time <= durationMs; time += periodMs) beats.push(Math.round(time));
  return beats;
}

function summarizeEnergy(rms: readonly number[], frameTimesMs: readonly number[], durationMs: number): number[] {
  if (durationMs <= 0) return [];
  const bucketMs = 50;
  const buckets = new Array(Math.max(1, Math.ceil(durationMs / bucketMs))).fill(0) as number[];
  const counts = new Array(buckets.length).fill(0) as number[];
  for (let index = 0; index < rms.length; index += 1) {
    const bucket = Math.min(buckets.length - 1, Math.max(0, Math.floor(frameTimesMs[index] / bucketMs)));
    buckets[bucket] += rms[index];
    counts[bucket] += 1;
  }
  for (let index = 0; index < buckets.length; index += 1) {
    if (counts[index] > 0) buckets[index] /= counts[index];
  }
  const reference = Math.max(1e-6, percentile(buckets, 0.95));
  return buckets.map((value) => Number(clamp(Math.sqrt(value / reference)).toFixed(4)));
}

function detectActivity(
  samples: Float32Array,
  sampleRate: number,
  durationMs: number,
): ActivityRegion[] {
  if (samples.length === 0 || durationMs <= 0) return [];
  const bucketSamples = Math.max(1, Math.round((sampleRate * ACTIVITY_BUCKET_MS) / 1_000));
  const bucketCount = Math.ceil(samples.length / bucketSamples);
  const bucketRms = new Array<number>(bucketCount);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * bucketSamples;
    const end = Math.min(samples.length, start + bucketSamples);
    let squareSum = 0;
    for (let index = start; index < end; index += 1) squareSum += samples[index] * samples[index];
    bucketRms[bucket] = end > start ? Math.sqrt(squareSum / (end - start)) : 0;
  }

  const audibleBuckets = bucketRms.filter((value) => value >= 3e-5);
  if (audibleBuckets.length === 0) return [];
  const reference = percentile(audibleBuckets, 0.9);
  const enterThreshold = Math.max(6e-5, reference * 0.06);
  const exitThreshold = Math.max(3e-5, reference * 0.03);
  const regions: ActivityRegion[] = [];
  let regionStart = -1;
  let quietStart = -1;

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const value = bucketRms[bucket];
    if (regionStart < 0) {
      if (value >= enterThreshold) regionStart = bucket;
      continue;
    }
    if (value >= exitThreshold) {
      quietStart = -1;
      continue;
    }
    if (quietStart < 0) quietStart = bucket;
    if (bucket - quietStart < 2) continue;

    const startMs = Math.round((regionStart * bucketSamples * 1_000) / sampleRate);
    const endMs = Math.round((quietStart * bucketSamples * 1_000) / sampleRate);
    if (endMs > startMs) regions.push({ startMs, endMs });
    regionStart = -1;
    quietStart = -1;
  }

  if (regionStart >= 0) {
    const startMs = Math.round((regionStart * bucketSamples * 1_000) / sampleRate);
    const endBucket = quietStart >= 0 ? quietStart : bucketCount;
    const endMs = Math.min(durationMs, Math.round((endBucket * bucketSamples * 1_000) / sampleRate));
    if (endMs > startMs) regions.push({ startMs, endMs });
  }
  return regions;
}

function matchingAttack(onsets: readonly Onset[], frameStartMs: number): Onset | undefined {
  let best: Onset | undefined;
  for (const onset of onsets) {
    const distance = frameStartMs - onset.timeMs;
    if (distance < -90 || distance > 180) continue;
    if (!best || Math.abs(distance) < Math.abs(frameStartMs - best.timeMs)) best = onset;
  }
  return best;
}

function detectSustains(
  frames: ReturnType<typeof extractFrames>,
  onsets: readonly Onset[],
  activity: readonly ActivityRegion[],
  sampleRate: number,
  durationMs: number,
): SustainRegion[] {
  if (frames.rms.length < 4 || onsets.length === 0 || activity.length === 0) return [];
  const hopMs = (HOP_SIZE * 1_000) / sampleRate;
  const rmsReference = percentile(frames.rms, 0.9);
  const audibleFloor = Math.max(6e-5, rmsReference * 0.045);
  const tonal = frames.rms.map((value, index) => value >= audibleFloor && frames.tonality[index] >= 0.55);
  const rawRegions: Array<{ start: number; end: number }> = [];

  let index = 0;
  while (index < tonal.length - 2) {
    const confirmsTone = tonal[index]
      && tonal[index + 1]
      && tonal[index + 2]
      && (frames.stability[index + 1] >= 0.78 || frames.stability[index + 2] >= 0.78);
    if (!confirmsTone) {
      index += 1;
      continue;
    }

    const start = index;
    let lastGood = index + 2;
    let cursor = index + 3;
    let misses = 0;
    let anchorBin = frames.dominantBins[index + 2];
    while (cursor < tonal.length) {
      const bin = frames.dominantBins[cursor];
      const binTolerance = Math.max(2, anchorBin * 0.055);
      const spectrumMatches = frames.stability[cursor] >= 0.78
        && (Math.abs(bin - anchorBin) <= binTolerance || frames.stability[cursor] >= 0.91);
      const active = frames.rms[cursor] >= audibleFloor;
      if (tonal[cursor] && spectrumMatches) {
        lastGood = cursor;
        misses = 0;
        anchorBin = anchorBin * 0.92 + bin * 0.08;
      } else if (active && misses < 1 && frames.tonality[cursor] >= 0.42) {
        misses += 1;
      } else {
        break;
      }
      cursor += 1;
    }
    rawRegions.push({ start, end: lastGood });
    index = Math.max(start + 1, lastGood + 1);
  }

  const sustains: SustainRegion[] = [];
  for (const region of rawRegions) {
    const frameStartMs = Math.max(0, frames.frameTimesMs[region.start] - hopMs / 2);
    const frameEndMs = Math.min(durationMs, frames.frameTimesMs[region.end] + hopMs / 2);
    const firstAttack = matchingAttack(onsets, frameStartMs);
    if (!firstAttack) continue;

    const splitAttacks = onsets.filter((onset) => {
      if (onset.timeMs < firstAttack.timeMs + 180 || onset.timeMs > frameEndMs - 140 || onset.strength < 0.12) {
        return false;
      }
      let nearestFrame = region.start;
      while (
        nearestFrame < region.end
        && frames.frameTimesMs[nearestFrame + 1] <= onset.timeMs
      ) nearestFrame += 1;
      let before = Number.POSITIVE_INFINITY;
      let after = 0;
      for (let frame = Math.max(region.start, nearestFrame - 4); frame <= nearestFrame; frame += 1) {
        before = Math.min(before, frames.rms[frame]);
      }
      for (let frame = nearestFrame; frame <= Math.min(region.end, nearestFrame + 4); frame += 1) {
        after = Math.max(after, frames.rms[frame]);
      }
      return onset.strength >= 0.65 || after >= Math.max(audibleFloor, before * 1.12);
    });
    const boundaries = [firstAttack.timeMs, ...splitAttacks.map((onset) => onset.timeMs), frameEndMs];
    for (let part = 0; part < boundaries.length - 1; part += 1) {
      let startMs = boundaries[part];
      let endMs = boundaries[part + 1];
      const containingActivity = activity.find((active) => (
        startMs >= active.startMs - 100 && startMs < active.endMs
      ));
      if (!containingActivity) continue;
      startMs = Math.max(startMs, containingActivity.startMs);
      endMs = Math.min(endMs, containingActivity.endMs);
      if (endMs - startMs < 220) continue;

      const included: number[] = [];
      for (let frame = region.start; frame <= region.end; frame += 1) {
        const timeMs = frames.frameTimesMs[frame];
        if (timeMs >= startMs && timeMs <= endMs) included.push(frame);
      }
      if (included.length < 3) continue;
      const meanTonality = included.reduce((sum, frame) => sum + frames.tonality[frame], 0) / included.length;
      const stableFrames = included.slice(1);
      const meanStability = stableFrames.length
        ? stableFrames.reduce((sum, frame) => sum + frames.stability[frame], 0) / stableFrames.length
        : 0;
      const attack = part === 0 ? firstAttack : splitAttacks[part - 1];
      const durationScore = clamp((endMs - startMs - 220) / 780);
      const confidence = clamp(
        meanTonality * 0.42 + meanStability * 0.36 + durationScore * 0.12 + attack.strength * 0.1,
      );
      if (confidence < 0.58) continue;
      sustains.push({
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        confidence: Number(confidence.toFixed(4)),
      });
    }
  }
  sustains.sort((first, second) => first.startMs - second.startMs || first.endMs - second.endMs);
  const nonOverlapping: SustainRegion[] = [];
  for (const sustain of sustains) {
    while (nonOverlapping.length > 0) {
      const previous = nonOverlapping[nonOverlapping.length - 1];
      if (sustain.startMs >= previous.endMs) break;
      previous.endMs = sustain.startMs;
      if (previous.endMs - previous.startMs >= 220) break;
      nonOverlapping.pop();
    }
    if (sustain.endMs - sustain.startMs >= 220) nonOverlapping.push(sustain);
  }
  return nonOverlapping;
}

export function analyzePCM(
  pcm: Float32Array,
  sampleRate: number,
  audioHash: string,
  onProgress?: (progress: number) => void,
): BeatAnalysis {
  onProgress?.(0);
  const prepared = preparePcm(pcm, sampleRate);
  const durationMs = Math.round((pcm.length / sampleRate) * 1_000);
  onProgress?.(0.04);
  const frames = extractFrames(prepared.samples, prepared.sampleRate, onProgress);
  const onsets = detectOnsets(
    frames.flux,
    frames.frameTimesMs,
    prepared.samples,
    prepared.sampleRate,
  );
  onProgress?.(0.7);
  const tempo = estimateTempo(onsets);
  const energy = summarizeEnergy(frames.rms, frames.frameTimesMs, durationMs);
  const activity = detectActivity(prepared.samples, prepared.sampleRate, durationMs);
  onProgress?.(0.78);
  const sustains = detectSustains(frames, onsets, activity, prepared.sampleRate, durationMs);
  const warnings: string[] = [];
  const absoluteRms = frames.rms.length ? frames.rms.reduce((sum, value) => sum + value, 0) / frames.rms.length : 0;
  if (prepared.replacedSamples > 0) warnings.push('non_finite_samples_replaced');
  if (absoluteRms < 1e-5 || onsets.length === 0) warnings.push('silence_or_no_onsets');
  if (tempo.ambiguous) warnings.push('half_double_tempo_ambiguous');
  if (tempo.confidence < 0.42) warnings.push('low_tempo_confidence');
  const activeEnergy = energy.filter((value) => value > 0.04);
  const energyMean = activeEnergy.length
    ? activeEnergy.reduce((sum, value) => sum + value, 0) / activeEnergy.length
    : 0;
  const onsetRate = durationMs > 0 ? (onsets.length * 1_000) / durationMs : 0;
  const intensity = clamp(energyMean * 0.68 + clamp(onsetRate / 6) * 0.32);
  onProgress?.(0.9);

  const result: BeatAnalysis = {
    version: ANALYSIS_VERSION,
    audioHash,
    durationMs,
    bpm: Number(tempo.bpm.toFixed(2)),
    beatsMs: buildBeats(durationMs, tempo.bpm, tempo.phaseMs),
    onsets,
    energy,
    confidence: Number(tempo.confidence.toFixed(4)),
    warnings,
    intensity: Number(intensity.toFixed(4)),
    sustains,
    activity,
  };
  onProgress?.(1);
  return result;
}
