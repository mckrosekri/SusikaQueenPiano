import { describe, expect, it } from 'vitest';
import { RATES, type Note } from '../types';
import { enforceTwoFingerBudget, requiredTouchEnd } from './touch-budget';
import { validateChart } from './chart';

const tap = (id: string, timeMs: number, lane = 2): Note => ({ id, kind: 'tap', timeMs, lane });
const hold = (id: string, lane: number, timeMs = 0, endTimeMs = 1000): Note => ({ id, kind: 'hold', lane, timeMs, endTimeMs });
const slide = (id: string, lane: number): Note => ({ ...hold(id, lane), kind: 'slide',
  targetLane: lane === 0 ? 1 : 2, path: [{ timeMs: 0, lane }, { timeMs: 1000, lane: lane === 0 ? 1 : 2 }] });

function assertCapacity(notes: Note[]) {
  for (const rate of RATES) {
    const events = notes.flatMap(note => [{ time: note.timeMs, delta: 1 }, { time: requiredTouchEnd(note, rate), delta: -1 }])
      .sort((a, b) => a.time - b.time || a.delta - b.delta);
    let fingers = 0;
    for (const event of events) { fingers += event.delta; expect(fingers).toBeLessThanOrEqual(2); }
  }
}

describe('two-finger arrangement budget', () => {
  it.each([
    [hold('dog-a', 0), hold('dog-b', 3)],
    [slide('slide-a', 0), slide('slide-b', 3)],
    [hold('dog', 0), slide('slide', 3)],
  ])('keeps two long gestures and removes a third command', (a, b) => {
    const notes = [a, b, tap('third', 500)];
    expect(enforceTwoFingerBudget(notes)).toEqual([a, b]);
    assertCapacity(enforceTwoFingerBudget(notes));
  });

  it.each([hold('dog', 0), slide('slide', 0)])('keeps one long gesture plus one tap, thinning a double', long => {
    const primary = tap('pulse', 500, 3), accent = tap('accent', 500, 2);
    const result = enforceTwoFingerBudget([long, primary, accent]);
    expect(result).toEqual([long, primary]);
    assertCapacity(result);
  });

  it('removes a preceding double accent when the next beat needs a finger at fast speed', () => {
    const result = enforceTwoFingerBudget([tap('pulse', 0, 0), tap('accent', 0, 1), tap('next', 150, 3)]);
    expect(result.map(note => note.id)).toEqual(['pulse', 'next']);
    assertCapacity(result);
  });

  it('simplifies a hold under dense taps without shifting or losing the musical attacks', () => {
    const input = [hold('dog', 0), tap('a', 500, 1), tap('b', 635, 3), tap('c', 770, 2)];
    const before = structuredClone(input);
    const result = enforceTwoFingerBudget(input);
    expect(result.map(note => note.timeMs)).toEqual(input.map(note => note.timeMs));
    expect(result[0]).toEqual(tap('dog', 0, 0));
    expect(input).toEqual(before);
    assertCapacity(result);
  });

  it('allows time for a flick before another pair of attacks', () => {
    const flick: Note = { id: 'swipe', kind: 'flick', lane: 0, timeMs: 0, direction: 1, targetLane: 1 };
    const result = enforceTwoFingerBudget([flick, tap('a', 180, 2), tap('b', 300, 3)]);
    expect(result[0]).toEqual(tap('swipe', 0, 0));
    assertCapacity(result);
  });

  it('reserves release time after two dogs before admitting the next tile', () => {
    const result = enforceTwoFingerBudget([hold('a', 0, 0, 500), hold('b', 3, 0, 500), tap('too-soon', 580), tap('next', 620)]);
    expect(result.map(note => note.id)).toEqual(['a', 'b', 'next']);
    assertCapacity(result);
  });

  it('validator rejects three realistic actions even though 45ms instant taps would pass', () => {
    const notes = [hold('dog', 0), tap('a', 500, 1), tap('b', 635, 3)];
    const errors = validateChart({ id: 'unsafe', version: 'test', audioHash: 'test', difficulty: 'expert',
      notes, durationMs: 2000, approachMs: 900, rating: 1 }, 1.5);
    expect(errors).toContain('more_than_two_touches:b');
  });
});
