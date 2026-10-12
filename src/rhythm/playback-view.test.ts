import { describe, expect, it } from 'vitest';
import type { PlaybackRate } from '../types';
import { playbackView } from './playback-view';

describe('playback view', () => {
  it('preserves the calibrated approach timeline during the initial count-in', () => {
    expect(playbackView(27_500, 30_000, 80, 1, false)).toEqual({
      timeMs: 27_420,
      countdown: '3',
      acceptsInput: false,
    });
    expect(playbackView(28_600, 30_000, 80, 1, false)).toEqual({
      timeMs: 28_520,
      countdown: '2',
      acceptsInput: false,
    });
  });

  it('holds a resumed view at the calibrated pause floor during a 2.5 second lead', () => {
    const rates: PlaybackRate[] = [0.75, 1, 1.5];

    for (const rate of rates) {
      const playableFromMs = 30_000;
      const sourceTimeMs = playableFromMs - 2_500 * rate;
      expect(playbackView(sourceTimeMs, playableFromMs, 120, rate, true)).toEqual({
        timeMs: playableFromMs - 120 * rate,
        countdown: '3',
        acceptsInput: false,
      });
    }
  });

  it('derives countdown numbers from wall time at every playback rate', () => {
    const rates: PlaybackRate[] = [0.75, 1, 1.5];

    for (const rate of rates) {
      expect(playbackView(30_000 - 1_999 * rate, 30_000, 0, rate, true).countdown).toBe('2');
      expect(playbackView(30_000 - 999 * rate, 30_000, 0, rate, true).countdown).toBe('1');
    }
  });

  it('opens input and resumes the calibrated source clock at the exact boundary', () => {
    expect(playbackView(29_999.999, 30_000, 50, 1.5, true)).toEqual({
      timeMs: 29_925,
      countdown: '1',
      acceptsInput: false,
    });
    expect(playbackView(30_000, 30_000, 50, 1.5, true)).toEqual({
      timeMs: 29_925,
      countdown: '',
      acceptsInput: true,
    });
    expect(playbackView(30_120, 30_000, 50, 1.5, true)).toEqual({
      timeMs: 30_045,
      countdown: '',
      acceptsInput: true,
    });
  });
});
