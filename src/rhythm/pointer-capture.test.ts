import { describe, expect, it, vi } from 'vitest';
import { capturePointerSafely } from './pointer-capture';
import { JudgementEngine } from './judgement';
import type { Chart, RunConfig } from '../types';

const config: RunConfig = { difficulty: 'normal', rate: 1, practice: false, startMs: 0, loop: false };
const chart: Chart = { id: 'input', version: 'test', audioHash: 'test', difficulty: 'normal', approachMs: 1050,
  durationMs: 4000, rating: 3, notes: [0, 1, 2].map(lane => ({ id: `n${lane}`, kind: 'tap', lane, timeMs: 1000 })) };

describe('pointer capture recovery', () => {
  it('unwinds a failed capture, preserves awarded points and allows the very next contact', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new JudgementEngine(chart, config, 'song');
    const pointers = new Set([1, 2]);
    engine.pointerDown(1, 0, 1000, 'n0'); engine.pointerDown(2, 1, 1000, 'n1');
    const score = engine.score;
    try {
      expect(capturePointerSafely({ setPointerCapture() { throw new DOMException('Bearer secret private-song.mp3', 'NotFoundError'); } },
        2, () => { pointers.delete(2); engine.pointerUp(2, 1000); })).toBe(false);
      expect(pointers.size).toBe(1);
      expect(engine.score).toBe(score);
      expect(engine.pointerDown(2, 2, 1000, 'n2')).toBe(true);
      expect(warning.mock.calls[0][1]).toMatchObject({ exceptionClass: 'NotFoundError', reason: 'pointer_capture_failed',
        correlationId: 'pointer-2', operation: 'input.pointer_capture', fallback: 'contact_released', retryable: false });
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/Bearer|secret|private-song/);
    } finally { warning.mockRestore(); }
  });

  it('successful capture keeps the contact until a real release and release is idempotent', () => {
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 0, 1000, 'n0'); engine.pointerDown(2, 1, 1000, 'n1');
    const release = vi.fn();
    expect(capturePointerSafely({ setPointerCapture() {} }, 2, release)).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(engine.pointerDown(3, 2, 1000, 'n2')).toBe(false);
    engine.pointerUp(2, 1000); engine.pointerUp(2, 1000);
    expect(engine.pointerDown(3, 2, 1000, 'n2')).toBe(true);
  });
});
