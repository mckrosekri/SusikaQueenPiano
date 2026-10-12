import { describe, expect, it } from 'vitest';
import { isTileHitEligible, MAX_RENDER_HIT_AGE_MS, pickTileHitTarget } from './tile-hit-target';
import { tileRectAtTime } from './tile-layout';
import { JudgementEngine } from './judgement';
import { RATES, type Chart, type RunConfig } from '../types';

const config: RunConfig = { difficulty: 'expert', rate: 1, practice: false, startMs: 0, loop: false };
const chart: Chart = { id: 'dense-input', version: 'test', audioHash: 'test', difficulty: 'expert', rating: 9,
  approachMs: 1050, durationMs: 4000, notes: [
    { id: 'first', kind: 'tap', lane: 0, timeMs: 1000 }, { id: 'next', kind: 'tap', lane: 0, timeMs: 1090 },
  ] };
const bounds = (top: number, bottom: number, id = 'tap') => ({ id, left: 0, right: 80, top, bottom,
  centerX: 40, centerY: (top + bottom) / 2 });

describe('responsive tile hit targeting', () => {
  it.each(RATES)('accepts the painted dense tile at 55ms frame skew at %sx without changing scoring time', rate => {
    const note = chart.notes[0];
    const render = tileRectAtTime(chart, note, rate, 1000, 780);
    const eventMs = 1000 + 55 * rate;
    const live = tileRectAtTime(chart, note, rate, eventMs, 780);
    const painted = bounds(render.top, render.bottom, note.id);
    const computed = bounds(live.top, live.bottom, note.id);
    if (rate >= 1) expect(pickTileHitTarget(40, painted.centerY, [computed], [], 55)).toBeUndefined();
    const hit = pickTileHitTarget(40, painted.centerY, [computed], [painted], 55);
    expect(hit?.id).toBe(note.id);
    expect(hit?.exact).toBe(true);
    const engine = new JudgementEngine(chart, { ...config, rate }, 'song');
    expect(engine.pointerDown(1, 0, eventMs, hit?.id)).toBe(true);
    expect(engine.states[0].errorMs).toBe(55 * rate);
  });

  it('never revives stale painted art past the bounded allowance', () => {
    const painted = bounds(100, 130), live = bounds(170, 200);
    expect(pickTileHitTarget(40, 115, [live], [painted], MAX_RENDER_HIT_AGE_MS)?.id).toBe('tap');
    expect(pickTileHitTarget(40, 115, [live], [painted], MAX_RENDER_HIT_AGE_MS + 1)).toBeUndefined();
    expect(pickTileHitTarget(40, 115, [live], [painted], -MAX_RENDER_HIT_AGE_MS - 1)).toBeUndefined();
  });

  it('prefers an exact painted target over a neighboring padded target', () => {
    const tap = bounds(100, 130, 'tap'), neighbor = bounds(134, 164, 'neighbor');
    expect(pickTileHitTarget(40, 129, [neighbor], [tap], 16)?.id).toBe('tap');
  });

  it('falls back to live geometry for newly entering tiles and keeps forgiving padding', () => {
    const tap = bounds(100, 130);
    expect(pickTileHitTarget(40, 100, [tap], [], Infinity)?.exact).toBe(true);
    expect(pickTileHitTarget(40, 95, [tap], [], Infinity)?.exact).toBe(false);
    expect(pickTileHitTarget(40, 93, [tap], [], Infinity)).toBeUndefined();
  });

  it('excludes already-owned and completed tiles, but permits released sustains', () => {
    const candidates = [
      { ...bounds(100, 130, 'owned'), status: 'active' as const, pointer: 1 },
      { ...bounds(100, 130, 'done'), status: 'done' as const },
      { ...bounds(100, 130, 'tap'), status: 'pending' as const },
    ];
    const eligible = candidates.filter(isTileHitEligible);
    expect(pickTileHitTarget(40, 115, eligible, eligible, 16)?.id).toBe('tap');
    expect(isTileHitEligible({ status: 'active' })).toBe(true);
  });
});
