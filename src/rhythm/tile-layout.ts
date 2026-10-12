import type { Chart, Note, PlaybackRate } from '../types';

export const MIN_TILE_APPROACH_WALL_MS = 900;
export const TAP_TILE_APPROACH_RATIO = 0.24;
export const SAME_LANE_GAP_RATIO = 0.84;
export const TILE_BEAT_LINE_RATIO = 0.7;

export interface TileTimeBounds {
  enterMs: number;
  onsetMs: number;
  exitMs: number;
  durationMs: number;
}

export interface TileRect {
  top: number;
  bottom: number;
  height: number;
  visible: boolean;
  interactable: boolean;
}

interface TileLayoutCache {
  nextSameLaneGapById: Map<string, number>;
  previousSameLaneGapById: Map<string, number>;
}

const layoutCaches = new WeakMap<Chart, TileLayoutCache>();

function layoutCache(chart: Chart): TileLayoutCache {
  const cached = layoutCaches.get(chart);
  if (cached !== undefined) return cached;

  const nextSameLaneGapById = new Map<string, number>();
  const previousSameLaneGapById = new Map<string, number>();
  const lanes = new Map<number, Note[]>();
  for (const note of chart.notes) {
    const lane = lanes.get(note.lane) ?? [];
    lane.push(note);
    lanes.set(note.lane, lane);
  }
  for (const lane of lanes.values()) {
    lane.sort((left, right) => left.timeMs - right.timeMs);
    for (let index = 0; index + 1 < lane.length; index += 1) {
      nextSameLaneGapById.set(lane[index].id, lane[index + 1].timeMs - lane[index].timeMs);
      const previous = lane[index];
      const previousTail = previous.kind === 'hold' || previous.kind === 'slide' ? previous.endTimeMs ?? previous.timeMs : previous.timeMs;
      previousSameLaneGapById.set(lane[index + 1].id, lane[index + 1].timeMs - previousTail);
    }
  }

  const created = { nextSameLaneGapById, previousSameLaneGapById };
  layoutCaches.set(chart, created);
  return created;
}

/** Source-timeline travel time. Its wall-clock value is always at least 900 ms. */
export function effectiveApproachMs(chart: Chart, rate: PlaybackRate): number {
  return Math.max(chart.approachMs, MIN_TILE_APPROACH_WALL_MS * rate);
}

/**
 * Source-timeline tile length. Sustains own their exact musical duration; short
 * tiles occupy roughly one quarter of the playfield and shrink before the next
 * tile in the same lane so their hit areas cannot overlap.
 */
export function tileDurationMs(chart: Chart, note: Note, rate: PlaybackRate): number {
  if ((note.kind === 'hold' || note.kind === 'slide') && note.endTimeMs !== undefined) {
    return Math.max(1, note.endTimeMs - note.timeMs);
  }

  const desired = effectiveApproachMs(chart, rate) * TAP_TILE_APPROACH_RATIO;
  const cache = layoutCache(chart);
  const nextGap = cache.nextSameLaneGapById.get(note.id) ?? Infinity;
  const previousGap = cache.previousSameLaneGapById.get(note.id) ?? Infinity;
  return Math.max(1, Math.min(desired, nextGap * SAME_LANE_GAP_RATIO, previousGap * SAME_LANE_GAP_RATIO));
}

export function tileTimeBounds(chart: Chart, note: Note, rate: PlaybackRate): TileTimeBounds {
  const durationMs = tileDurationMs(chart, note, rate);
  const centered = note.kind === 'tap' || note.kind === 'flick';
  const approachMs = effectiveApproachMs(chart, rate);
  return {
    enterMs: note.timeMs - approachMs * TILE_BEAT_LINE_RATIO - (centered ? durationMs / 2 : 0),
    onsetMs: note.timeMs,
    exitMs: centered ? note.timeMs + durationMs / 2 + approachMs * (1 - TILE_BEAT_LINE_RATIO) : note.endTimeMs ?? note.timeMs,
    durationMs,
  };
}

export function isTileInteractable(chart: Chart, note: Note, rate: PlaybackRate, timeMs: number): boolean {
  const bounds = tileTimeBounds(chart, note, rate);
  return timeMs >= bounds.enterMs && timeMs <= bounds.exitMs;
}

/**
 * Returns the tile rectangle in playfield pixels. The note onset is the instant
 * its center reaches the rhythm line for taps/flicks, or its head for sustains. Short tiles remain
 * playable to the bottom; a sustain ends when its musical tail reaches the cue.
 */
export function tileRectAtTime(
  chart: Chart,
  note: Note,
  rate: PlaybackRate,
  timeMs: number,
  playfieldHeight: number,
): TileRect {
  const approachMs = effectiveApproachMs(chart, rate);
  const durationMs = tileDurationMs(chart, note, rate);
  const pixelsPerMs = Math.max(0, playfieldHeight) / approachMs;
  const height = durationMs * pixelsPerMs;
  const centered = note.kind === 'tap' || note.kind === 'flick';
  const bottom = playfieldHeight * TILE_BEAT_LINE_RATIO - (note.timeMs - timeMs) * pixelsPerMs + (centered ? height / 2 : 0);
  const top = bottom - height;
  const bounds = tileTimeBounds(chart, note, rate);
  const visible = playfieldHeight > 0 && timeMs >= bounds.enterMs && timeMs <= bounds.exitMs;
  return { top, bottom, height, visible, interactable: visible };
}
