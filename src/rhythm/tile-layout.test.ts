import { describe, expect, it } from 'vitest';
import type { Chart, Note } from '../types';
import { RATES } from '../types';
import { playbackView } from './playback-view';
import { validateChart } from './chart';
import {
  effectiveApproachMs,
  isTileInteractable,
  tileDurationMs,
  tileRectAtTime,
  tileTimeBounds,
} from './tile-layout';

const notes: Note[] = [
  { id: 'a', kind: 'tap', lane: 0, timeMs: 1_000 },
  { id: 'other-lane', kind: 'tap', lane: 1, timeMs: 1_050 },
  { id: 'b', kind: 'flick', lane: 0, timeMs: 1_200, direction: 1, targetLane: 1 },
  { id: 'hold', kind: 'hold', lane: 2, timeMs: 1_500, endTimeMs: 2_500 },
];
const chart: Chart = {
  id: 'layout',
  version: 'v1',
  audioHash: 'test',
  difficulty: 'normal',
  rating: 4,
  approachMs: 1_050,
  durationMs: 4_000,
  notes,
};

describe('shared tile layout', () => {
  it('keeps at least 900 ms of wall-clock approach time at every speed', () => {
    expect(effectiveApproachMs({ ...chart, approachMs: 760 }, 0.75)).toBe(760);
    expect(effectiveApproachMs({ ...chart, approachMs: 760 }, 1)).toBe(900);
    expect(effectiveApproachMs({ ...chart, approachMs: 760 }, 1.5)).toBe(1_350);
  });

  it('makes readable short tiles without overlapping the next same-lane tile', () => {
    expect(tileDurationMs(chart, notes[0], 1)).toBe(168);
    expect(tileDurationMs(chart, notes[1], 1)).toBe(252);
    expect(tileDurationMs(chart, notes[2], 1)).toBe(168);
    expect(notes[0].timeMs + tileDurationMs(chart, notes[0], 1)).toBeLessThan(notes[2].timeMs);
  });

  it('uses the full authored sustain as the tile body and hit lifetime', () => {
    expect(tileDurationMs(chart, notes[3], 1.5)).toBe(1_000);
    expect(tileTimeBounds(chart, notes[3], 1)).toEqual({
      enterMs: 765,
      onsetMs: 1_500,
      exitMs: 2_500,
      durationMs: 1_000,
    });
  });

  it('maps onset to the comfortable rhythm cue and short-tile expiry to the bottom', () => {
    const note = notes[2];
    const bounds = tileTimeBounds(chart, note, 1);
    const entering = tileRectAtTime(chart, note, 1, bounds.enterMs, 600);
    const onset = tileRectAtTime(chart, note, 1, bounds.onsetMs, 600);
    const exiting = tileRectAtTime(chart, note, 1, bounds.exitMs, 600);
    expect(entering.bottom).toBeCloseTo(0);
    expect((onset.top + onset.bottom) / 2).toBeCloseTo(420);
    expect(exiting.top).toBeCloseTo(600);
    expect(entering.visible).toBe(true);
    expect(exiting.interactable).toBe(true);
    expect(tileRectAtTime(chart, note, 1, bounds.exitMs + 1, 600).visible).toBe(false);
  });

  it('ends a sustain at its authored musical tail while all displayed tiles stay hittable', () => {
    const note = notes[3];
    const bounds = tileTimeBounds(chart, note, 1);
    expect(bounds.exitMs).toBe(note.endTimeMs);
    expect(tileRectAtTime(chart, note, 1, bounds.exitMs, 600).top).toBeCloseTo(420);
    expect(tileRectAtTime(chart, note, 1, bounds.exitMs + 1, 600).visible).toBe(false);
  });

  it('uses the exact same inclusive time bounds for rendering and input', () => {
    const bounds = tileTimeBounds(chart, notes[0], 1);
    expect(isTileInteractable(chart, notes[0], 1, bounds.enterMs)).toBe(true);
    expect(isTileInteractable(chart, notes[0], 1, bounds.exitMs)).toBe(true);
    expect(isTileInteractable(chart, notes[0], 1, bounds.enterMs - 0.01)).toBe(false);
    expect(isTileInteractable(chart, notes[0], 1, bounds.exitMs + 0.01)).toBe(false);
  });

  it('precomputes correct same-lane gaps for dense immutable charts', () => {
    const denseNotes = Array.from({ length: 2_000 }, (_, index): Note => ({
      id: `dense-${index}`,
      kind: 'tap',
      lane: index % 4,
      timeMs: index * 40,
    })).reverse();
    const dense = Object.freeze({
      ...chart,
      id: 'dense',
      notes: Object.freeze(denseNotes),
      durationMs: 90_000,
    }) as unknown as Chart;
    const first = denseNotes.find((note) => note.id === 'dense-0')!;
    expect(tileDurationMs(dense, first, 1)).toBeCloseTo(160 * 0.84);
    for (let index = 0; index < 100; index += 1) {
      expect(tileDurationMs(dense, first, 1)).toBeCloseTo(134.4);
    }
  });
  it('puts tap/flick centers on the musical onset across viewport heights, speeds and calibration', () => {
    for (const rate of RATES) for (const height of [600, 744, 1000]) for (const note of notes.slice(0, 3)) {
      const source = note.timeMs + 120 * rate;
      const view = playbackView(source, 0, 120, rate, false);
      const rect = tileRectAtTime(chart, note, rate, view.timeMs, height);
      expect((rect.top + rect.bottom) / 2).toBeCloseTo(height * .7);
      const entering = tileRectAtTime(chart, note, rate, tileTimeBounds(chart, note, rate).enterMs, height);
      expect(entering.bottom).toBeCloseTo(0);
    }
  });
  it('keeps centered rectangles apart with unequal adjacent gaps and after a sustain tail', () => {
    const uneven = { ...chart, notes: [
      { id: 'a', kind: 'tap' as const, lane: 0, timeMs: 1000 },
      { id: 'b', kind: 'tap' as const, lane: 0, timeMs: 1080 },
      { id: 'c', kind: 'tap' as const, lane: 0, timeMs: 1600 },
      { id: 'dog', kind: 'hold' as const, lane: 0, timeMs: 2500, endTimeMs: 3500 },
      { id: 'after', kind: 'tap' as const, lane: 0, timeMs: 3570 },
    ] };
    for (const rate of RATES) for (let index = 1; index < uneven.notes.length; index++) {
      const previous = tileRectAtTime(uneven, uneven.notes[index - 1], rate, 2000, 744);
      const next = tileRectAtTime(uneven, uneven.notes[index], rate, 2000, 744);
      expect(next.bottom).toBeLessThan(previous.top);
    }
  });
  it('preserves separation at a validator-valid sustain-tail boundary at every speed', () => {
    const boundary = { ...chart, notes: [
      { id: 'dog', kind: 'hold' as const, lane: 0, timeMs: 1000, endTimeMs: 2000 },
      { id: 'after', kind: 'tap' as const, lane: 0, timeMs: 2090 },
    ] };
    for (const rate of RATES) {
      expect(validateChart(boundary, rate)).toEqual([]);
      const dog = tileRectAtTime(boundary, boundary.notes[0], rate, 1900, 744);
      const after = tileRectAtTime(boundary, boundary.notes[1], rate, 1900, 744);
      expect(after.bottom).toBeLessThan(dog.top);
    }
  });
});
