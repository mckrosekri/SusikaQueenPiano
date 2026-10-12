import { describe, expect, it } from 'vitest';
import {
  advanceSustainConsumption,
  remainingSlideRibbon,
  streamingSustainGeometry,
  sustainConsumptionGeometry,
} from './sustain-visual';

describe('sustain visual consumption', () => {
  it('starts consuming immediately after an early capture and finishes at the authored end', () => {
    const justAfterCapture = advanceSustainConsumption(0, 400, 2_000, 401, true, true);
    expect(justAfterCapture).toBeGreaterThan(0);
    expect(advanceSustainConsumption(justAfterCapture, 400, 2_000, 1_200, true, true)).toBeCloseTo(0.5);
    expect(advanceSustainConsumption(0.5, 400, 2_000, 2_000, true, true)).toBe(1);
  });

  it('uses the remaining source time for a late capture and still finishes at the authored end', () => {
    expect(advanceSustainConsumption(0, 1_500, 2_000, 1_750, true, true)).toBeCloseTo(0.5);
    expect(advanceSustainConsumption(0.5, 1_500, 2_000, 2_000, true, true)).toBe(1);
  });

  it('is invariant to render cadence and playback-rate wall time', () => {
    const sourceSamples = [1_000, 1_080, 1_260, 1_500];
    const sampled = sourceSamples.reduce(
      (fraction, timeMs) => advanceSustainConsumption(fraction, 1_000, 2_000, timeMs, true, true),
      0,
    );
    const sparse = advanceSustainConsumption(0, 1_000, 2_000, 1_500, true, true);

    // 500 ms of authored music is the same fraction at 0.75x, 1x, or 1.5x wall-clock speed.
    for (const rate of [0.75, 1, 1.5]) {
      const wallElapsedMs = 500 / rate;
      const sourceTimeMs = 1_000 + wallElapsedMs * rate;
      expect(advanceSustainConsumption(0, 1_000, 2_000, sourceTimeMs, true, true)).toBeCloseTo(0.5);
    }
    expect(sampled).toBeCloseTo(sparse);
  });

  it('freezes while released, outside the valid lane, or on a frozen pause clock', () => {
    const previous = 0.35;
    expect(advanceSustainConsumption(previous, 1_000, 2_000, 1_800, false, true)).toBe(previous);
    expect(advanceSustainConsumption(previous, 1_000, 2_000, 1_800, true, false)).toBe(previous);
    expect(advanceSustainConsumption(previous, 1_000, 2_000, 1_350, true, true)).toBe(previous);
  });

  it('never decreases on re-grab and resumes when source progress passes the saved fraction', () => {
    const saved = 0.6;
    expect(advanceSustainConsumption(saved, 1_000, 2_000, 1_450, true, true)).toBe(saved);
    expect(advanceSustainConsumption(saved, 1_000, 2_000, 1_800, true, true)).toBeCloseTo(0.8);
  });

  it('anchors the remaining body to the finger and reaches exact zero height', () => {
    expect(sustainConsumptionGeometry(500, 320, 0.25)).toEqual({
      top: 260,
      bottom: 500,
      height: 240,
    });
    expect(sustainConsumptionGeometry(500, 320, 1)).toEqual({
      top: 500,
      bottom: 500,
      height: 0,
    });
  });

  it('keeps early-armed tails on their stream and feeds them into the rhythm cue at the authored onset', () => {
    expect(streamingSustainGeometry(300, 490, 280, 0)).toEqual({ top: 20, bottom: 300, height: 280 });
    expect(streamingSustainGeometry(490, 490, 280, 0)).toEqual({ top: 210, bottom: 490, height: 280 });
    expect(streamingSustainGeometry(630, 490, 280, .5)).toEqual({ top: 350, bottom: 490, height: 140 });
    expect(streamingSustainGeometry(770, 490, 280, 1)).toEqual({ top: 490, bottom: 490, height: 0 });
  });

  it('never shifts a consumed body above its canonical stream or into the following tile', () => {
    const line = 490, originalHeight = 280;
    for (const progress of [0, .1, .5, .9, 1]) {
      const rawBottom = line + progress * originalHeight;
      const rawTop = rawBottom - originalHeight;
      const held = streamingSustainGeometry(rawBottom, line, originalHeight, progress);
      expect(held.top).toBeCloseTo(rawTop);
      expect(held.bottom).toBeLessThanOrEqual(rawBottom);
      const followingBottom = rawTop - 25;
      expect(followingBottom).toBeLessThan(held.top);
    }
  });

  it('clips a late capture to canonical geometry even before its first progress update', () => {
    expect(streamingSustainGeometry(630, 490, 280, 0)).toEqual({ top: 350, bottom: 490, height: 140 });
  });

  it('keeps the remaining multi-lane ribbon attached to the current authored position', () => {
    const path = [
      { timeMs: 1_000, lane: 0 },
      { timeMs: 1_300, lane: 0 },
      { timeMs: 1_900, lane: 3 },
    ];
    const ribbon = remainingSlideRibbon(path, 1_500, 1_900, 490, 160, 100);

    expect(ribbon[0]).toEqual({ timeMs: 1_500, lane: 1, y: 490 });
    expect(ribbon.at(-1)).toEqual({ timeMs: 1_900, lane: 3, y: 330 });
    expect(ribbon.map((point) => point.y)).toEqual([...ribbon].map((point) => point.y).sort((a, b) => b - a));
  });

  it('shrinks the ribbon monotonically through lane transitions without regrowing', () => {
    const path = [
      { timeMs: 1_000, lane: 3 },
      { timeMs: 1_250, lane: 3 },
      { timeMs: 2_000, lane: 0 },
    ];
    const samples = [1_000, 1_250, 1_500, 1_750, 2_000].map((timeMs) => {
      const consumed = advanceSustainConsumption(0, 1_000, 2_000, timeMs, true, true);
      const geometry = streamingSustainGeometry(490 + consumed * 320, 490, 320, consumed);
      const ribbon = remainingSlideRibbon(path, timeMs, 2_000, geometry.bottom, geometry.height);
      return { timeMs, height: geometry.height, lane: ribbon[0].lane, ribbonHeight: ribbon[0].y - ribbon.at(-1)!.y };
    });

    expect(samples.map((sample) => sample.height)).toEqual([320, 240, 160, 80, 0]);
    expect(samples.map((sample) => sample.ribbonHeight)).toEqual([320, 240, 160, 80, 0]);
    expect(samples.map((sample) => sample.lane)).toEqual([3, 3, 2, 1, 0]);
  });
});
