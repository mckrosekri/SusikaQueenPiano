export interface SustainConsumptionGeometry {
  top: number;
  bottom: number;
  height: number;
}

export interface SlidePathPoint {
  timeMs: number;
  lane: number;
}

export interface SlideRibbonPoint extends SlidePathPoint {
  y: number;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Advances visual sustain consumption on the authored source timeline.
 * Gameplay supplies the authored note onset and true/true: released tails keep
 * flowing with the music. The optional contact gates support paused/legacy
 * callers; consumption never changes score or canonical tile geometry.
 */
export function advanceSustainConsumption(
  previousFraction: number,
  timelineStartMs: number,
  endTimeMs: number,
  timeMs: number,
  connected: boolean,
  following: boolean,
): number {
  const previous = clampFraction(previousFraction);
  if (!connected || !following) return previous;
  if (![timelineStartMs, endTimeMs, timeMs].every(Number.isFinite)) return previous;

  if (endTimeMs <= timelineStartMs) {
    return timeMs >= endTimeMs ? 1 : previous;
  }

  const sourceProgress = clampFraction((timeMs - timelineStartMs) / (endTimeMs - timelineStartMs));
  return Math.max(previous, sourceProgress);
}

/** Keeps the remaining sustain attached to the finger and removes its consumed tail. */
export function sustainConsumptionGeometry(
  fingerY: number,
  originalHeight: number,
  consumedFraction: number,
): SustainConsumptionGeometry {
  const remainingHeight = Math.max(0, originalHeight) * (1 - clampFraction(consumedFraction));
  return {
    top: fingerY - remainingHeight,
    bottom: fingerY,
    height: remainingHeight,
  };
}

/** A held body keeps its canonical stream position; finger movement cannot shift it into the next tile. */
export function streamingSustainGeometry(
  rawBottom: number,
  beatLineY: number,
  originalHeight: number,
  consumedFraction: number,
): SustainConsumptionGeometry {
  const bottom = Math.min(rawBottom, beatLineY);
  const authoredHeight = Math.max(0, originalHeight);
  const canonicalTop = rawBottom - authoredHeight;
  const height = Math.min(authoredHeight * (1 - clampFraction(consumedFraction)), Math.max(0, bottom - canonicalTop));
  return { top: bottom - height, bottom, height };
}

function pathLaneAt(path: readonly SlidePathPoint[], timeMs: number): number {
  if (path.length === 0) return 0;
  if (timeMs <= path[0].timeMs) return path[0].lane;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const next = path[index];
    if (timeMs <= next.timeMs) {
      return previous.lane + (next.lane - previous.lane)
        * (timeMs - previous.timeMs) / Math.max(1, next.timeMs - previous.timeMs);
    }
  }
  return path.at(-1)?.lane ?? 0;
}

/** Samples only the unconsumed authored slide path, anchored at the eating edge. */
export function remainingSlideRibbon(
  path: readonly SlidePathPoint[],
  timeMs: number,
  endTimeMs: number,
  bottom: number,
  remainingHeight: number,
  sampleStepMs = 40,
): SlideRibbonPoint[] {
  if (path.length === 0 || ![timeMs, endTimeMs, bottom, remainingHeight].every(Number.isFinite)) return [];
  const pathStart = path[0].timeMs;
  const startTimeMs = Math.max(pathStart, Math.min(endTimeMs, timeMs));
  const durationMs = Math.max(0, endTimeMs - startTimeMs);
  const height = Math.max(0, remainingHeight);
  const times = new Set<number>([startTimeMs, endTimeMs]);
  for (const point of path) if (point.timeMs > startTimeMs && point.timeMs < endTimeMs) times.add(point.timeMs);
  const step = Math.max(8, sampleStepMs);
  for (let sample = startTimeMs + step; sample < endTimeMs; sample += step) times.add(sample);

  return [...times].sort((left, right) => left - right).map((pointTimeMs) => ({
    timeMs: pointTimeMs,
    lane: pathLaneAt(path, pointTimeMs),
    y: bottom - (durationMs === 0 ? 0 : (pointTimeMs - startTimeMs) / durationMs) * height,
  }));
}
