import { RATES, type Note } from '../types';

export const ARRANGEMENT_VERSION = 'afterbeat-chart-v6';
export const MAX_REQUIRED_FINGERS = 2;
// Wall-clock budgets include lifting/repositioning a finger. Arrange against the
// fastest supported speed, so slower playback cannot introduce a third command.
export const TAP_ACTION_MS = 120;
export const FLICK_ACTION_MS = 220;
export const SUSTAIN_RELEASE_MS = 80;
const FASTEST_RATE = Math.max(...RATES);
type Gesture = Omit<Note, 'id'>;

export function requiredTouchEnd(note: Gesture, rate: number): number {
  if ((note.kind === 'hold' || note.kind === 'slide') && note.endTimeMs !== undefined) {
    return note.endTimeMs + SUSTAIN_RELEASE_MS * rate;
  }
  return note.timeMs + (note.kind === 'flick' ? FLICK_ACTION_MS : TAP_ACTION_MS) * rate;
}

function asTap<T extends Gesture>(note: T): T {
  const { endTimeMs: _end, targetLane: _target, direction: _direction, path: _path, ...rest } = note;
  return { ...rest, kind: 'tap' } as T;
}

/** Keep musical timestamps; thin optional doubles before simplifying busy gestures. */
export function enforceTwoFingerBudget<T extends Gesture>(notes: readonly T[]): T[] {
  const ordered = [...notes].sort((a, b) => a.timeMs - b.timeMs);
  const firstAtTime = new Map<number, T>();
  for (const note of ordered) if (!firstAtTime.has(note.timeMs)) firstAtTime.set(note.timeMs, note);
  const accepted: T[] = [];
  for (const candidate of ordered) {
    accepted.push(candidate);
    let active = accepted.filter(note => requiredTouchEnd(note, FASTEST_RATE) > candidate.timeMs);
    while (active.length > MAX_REQUIRED_FINGERS) {
      // A second short note on the same beat is an accent, not the core pulse.
      const accent = [...active].reverse().find(note => note.kind !== 'hold' && note.kind !== 'slide'
        && firstAtTime.get(note.timeMs) !== note);
      const sustains = active.filter(note => note.kind === 'hold' || note.kind === 'slide');
      const simplifiable = sustains.length < 2 ? active.find(note => note.kind !== 'tap'
        && note.timeMs + TAP_ACTION_MS * FASTEST_RATE <= candidate.timeMs) : undefined;
      if (accent) accepted.splice(accepted.indexOf(accent), 1);
      else if (simplifiable) accepted[accepted.indexOf(simplifiable)] = asTap(simplifiable);
      else accepted.splice(accepted.indexOf(active.at(-1)!), 1);
      active = accepted.filter(note => requiredTouchEnd(note, FASTEST_RATE) > candidate.timeMs);
    }
  }
  return accepted;
}
