import type { PlaybackRate } from '../types';

export interface PlaybackView {
  timeMs: number;
  countdown: string;
  acceptsInput: boolean;
}

/**
 * Converts the transport's source clock into the gameplay clock shown for a
 * playback start. Initial starts retain their approach travel. Resume starts
 * hold the paused gameplay frame until the transport reaches its scheduled
 * source offset again.
 */
export function playbackView(
  sourceTimeMs: number,
  playableFromMs: number,
  calibrationMs: number,
  rate: PlaybackRate,
  resuming: boolean,
): PlaybackView {
  const acceptsInput = sourceTimeMs >= playableFromMs;
  const visualSourceTimeMs = resuming && !acceptsInput ? playableFromMs : sourceTimeMs;
  const remainingWallMs = Math.max(0, playableFromMs - sourceTimeMs) / rate;

  return {
    timeMs: visualSourceTimeMs - calibrationMs * rate,
    countdown: remainingWallMs > 0 ? String(Math.ceil(remainingWallMs / 1_000)) : '',
    acceptsInput,
  };
}
