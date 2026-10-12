import type { Chart, Judgement, Note, RunConfig, RunResult } from '../types';
import { effectiveApproachMs, isTileInteractable, tileTimeBounds } from './tile-layout';

/** Kept for callers that display legacy timing examples; tile mode does not use these windows. */
export const WINDOWS = { perfect: 45, great: 90, good: 135 } as const;
const LANE_TOLERANCE = 0.78;
export const SCORING_VERSION = 'tiles-v5-rhythm-line';

/** A forgiving center band, then a smooth distance penalty; visible taps never become misses. */
export function lineHitCredit(chart: Chart, rate: RunConfig['rate'], errorMs: number): number {
  const distance = Math.abs(errorMs) / effectiveApproachMs(chart, rate);
  return Math.max(.65, 1 - Math.max(0, distance - .045) * .4);
}

function lineHitJudgement(credit: number): Judgement {
  return credit >= 1 ? 'perfect' : credit >= .92 ? 'great' : 'good';
}

export function judgeTiming(errorMs: number): Judgement {
  const delta = Math.abs(errorMs);
  return delta <= WINDOWS.perfect ? 'perfect' : delta <= WINDOWS.great ? 'great' : delta <= WINDOWS.good ? 'good' : 'miss';
}

export function laneAt(note: Note, timeMs: number): number {
  const path = note.path;
  if (!path?.length) return note.lane;
  if (timeMs <= path[0].timeMs) return path[0].lane;
  for (let index = 1; index < path.length; index += 1) {
    if (timeMs <= path[index].timeMs) {
      const previous = path[index - 1];
      const next = path[index];
      return previous.lane + (next.lane - previous.lane)
        * (timeMs - previous.timeMs) / Math.max(1, next.timeMs - previous.timeMs);
    }
  }
  return path.at(-1)?.lane ?? note.lane;
}

/** Exact time inside a linear slide path's lane tolerance, even after a stalled frame. */
function coveredDuration(note: Note, from: number, until: number, lane: number): number {
  const boundaries = [from, ...(note.path ?? []).map(point => point.timeMs)
    .filter(time => time > from && time < until), until];
  let covered = 0;
  for (let i = 1; i < boundaries.length; i += 1) {
    const start = boundaries[i - 1], end = boundaries[i];
    const first = laneAt(note, start), last = laneAt(note, end), change = last - first;
    if (Math.abs(change) < 1e-9) {
      if (Math.abs(lane - first) <= LANE_TOLERANCE) covered += end - start;
    } else {
      const a = (lane - LANE_TOLERANCE - first) / change;
      const b = (lane + LANE_TOLERANCE - first) / change;
      covered += (end - start) * Math.max(0, Math.min(1, Math.max(a, b)) - Math.max(0, Math.min(a, b)));
    }
  }
  return covered;
}

export interface NoteState {
  note: Note;
  status: 'pending' | 'active' | 'done';
  judgement?: Judgement;
  errorMs?: number;
  pointer?: number;
  lastLane?: number;
  coverageMs: number;
  sampledMs: number;
  lastSample?: number;
  releasedAt?: number;
  flickMoved: boolean;
  headFeedbackSent: boolean;
}

export interface HitFeedback {
  lane: number;
  judgement: Judgement;
  kind: Note['kind'];
  errorMs: number;
  combo: number;
  phase?: 'start' | 'complete';
  credit?: number;
}

export class JudgementEngine {
  readonly states: NoteState[];
  combo = 0;
  maxCombo = 0;
  early = 0;
  late = 0;
  counts: Record<Judgement, number> = { perfect: 0, great: 0, good: 0, miss: 0 };
  private earned = 0;
  private finalized = 0;
  private readonly downPointers = new Set<number>();

  constructor(
    readonly chart: Chart,
    readonly config: RunConfig,
    readonly songId: string,
    private feedback?: (hit: HitFeedback) => void,
  ) {
    this.states = chart.notes
      .filter((note) => note.timeMs >= config.startMs && note.timeMs < (config.endMs ?? chart.durationMs))
      .map((note) => ({
        note,
        status: 'pending',
        coverageMs: 0,
        sampledMs: 0,
        flickMoved: false,
        headFeedbackSent: false,
      }));
  }

  get accuracy(): number {
    return this.finalized ? this.earned / this.finalized * 100 : 100;
  }

  get score(): number {
    return Math.round(this.earned / Math.max(1, this.states.length) * 1_000_000);
  }

  /** An empty-lane tap breaks the streak without inventing a chart note or removing points. */
  breakCombo(lane: number): void {
    if (this.combo === 0) return;
    this.combo = 0;
    this.feedback?.({ lane, judgement: 'miss', kind: 'tap', errorMs: 0, combo: 0, phase: 'complete', credit: 0 });
  }

  /** Keyboard routing shares eligibility with scoring, including a released slide's current lane. */
  keyboardTarget(lane: number, timeMs: number): NoteState | undefined {
    return this.findReleased(lane, timeMs) ?? this.findPending(lane, timeMs);
  }

  /**
   * Starts the exact visible tile when noteId is supplied. Keyboard callers omit
   * noteId and receive the visible pending tile nearest the line in the requested lane.
   * timeMs is always source-timeline time.
   */
  pointerDown(pointer: number, lane: number, timeMs: number, noteId?: string): boolean {
    if (this.downPointers.has(pointer) || this.downPointers.size >= 2) return false;

    const released = this.findReleased(lane, timeMs, noteId);
    if (released !== undefined) {
      this.sample(released, timeMs);
      released.pointer = pointer;
      released.lastLane = lane;
      released.lastSample = Math.max(timeMs, released.note.timeMs, released.lastSample ?? 0);
      released.releasedAt = undefined;
      this.downPointers.add(pointer);
      return true;
    }

    const state = this.findPending(lane, timeMs, noteId);
    if (state === undefined) return false;
    const short = state.note.kind === 'tap' || state.note.kind === 'flick';
    state.errorMs = short ? timeMs - state.note.timeMs : 0;
    const credit = short ? lineHitCredit(this.chart, this.config.rate, state.errorMs) : 1;
    state.judgement = short ? lineHitJudgement(credit) : 'perfect';

    if (state.note.kind === 'tap') {
      this.downPointers.add(pointer);
      this.finalize(state, state.judgement, credit);
      return true;
    }

    state.status = 'active';
    state.pointer = pointer;
    state.lastLane = lane;
    state.lastSample = Math.max(timeMs, state.note.timeMs);
    state.headFeedbackSent = true;
    this.downPointers.add(pointer);
    this.feedback?.({ lane, judgement: state.judgement, kind: state.note.kind, errorMs: state.errorMs, combo: this.combo, phase: 'start', credit });
    return true;
  }

  pointerMove(pointer: number, lane: number, timeMs: number): void {
    const state = this.states.find((candidate) => candidate.status === 'active' && candidate.pointer === pointer);
    if (state === undefined) return;
    this.sample(state, timeMs);
    state.lastLane = lane;
    if (state.note.kind !== 'flick') return;

    const inferredDirection = Math.sign((state.note.targetLane ?? state.note.lane + 1) - state.note.lane) || 1;
    const direction = state.note.direction ?? inferredDirection;
    const bounds = tileTimeBounds(this.chart, state.note, this.config.rate);
    if (timeMs <= bounds.exitMs && (lane - state.note.lane) * direction >= 0.22) {
      state.flickMoved = true;
      const credit = lineHitCredit(this.chart, this.config.rate, state.errorMs ?? 0);
      this.finalize(state, lineHitJudgement(credit), credit);
    }
  }

  pointerUp(pointer: number, timeMs: number): void {
    this.downPointers.delete(pointer);
    const state = this.states.find((candidate) => candidate.status === 'active' && candidate.pointer === pointer);
    if (state === undefined) return;
    this.sample(state, timeMs);
    const endMs = state.note.endTimeMs ?? tileTimeBounds(this.chart, state.note, this.config.rate).exitMs;
    if (state.note.kind !== 'flick' && timeMs >= endMs) {
      this.finishSustain(state);
      return;
    }
    state.pointer = undefined;
    state.lastLane = undefined;
    state.releasedAt = timeMs;
  }

  cancelAll(timeMs: number): void {
    for (const state of this.states) {
      if (state.status === 'active' && state.pointer !== undefined) this.pointerUp(state.pointer, timeMs);
    }
    this.downPointers.clear();
  }

  /** Pause releases pointers while preserving already earned duration. */
  suspend(timeMs: number): void {
    for (const state of this.states) {
      if (state.status !== 'active') continue;
      this.sample(state, timeMs);
      state.pointer = undefined;
      state.lastLane = undefined;
      state.releasedAt = undefined;
    }
    this.downPointers.clear();
  }

  update(timeMs: number): void {
    for (const state of this.states) {
      const bounds = tileTimeBounds(this.chart, state.note, this.config.rate);
      if (state.status === 'pending' && timeMs > bounds.exitMs) {
        this.finalize(state, 'miss', 0);
        continue;
      }
      if (state.status !== 'active') continue;

      if (state.note.kind === 'flick') {
        if (timeMs > bounds.exitMs) this.finalize(state, 'miss', 0);
        continue;
      }

      this.sample(state, timeMs);
      const endMs = state.note.endTimeMs ?? bounds.exitMs;
      if (timeMs >= endMs) this.finishSustain(state);
    }
  }

  result(completed: boolean): RunResult {
    if (completed) {
      for (const state of this.states) if (state.status !== 'done') this.finalize(state, 'miss', 0);
    }
    return {
      id: crypto.randomUUID(),
      songId: this.songId,
      chartId: `${SCORING_VERSION}:${this.chart.id}`,
      difficulty: this.config.difficulty,
      rate: this.config.rate,
      score: this.score,
      accuracy: this.finalized ? Math.round(this.accuracy * 100) / 100 : 0,
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      early: this.early,
      late: this.late,
      practice: this.config.practice,
      createdAt: Date.now(),
      completed,
    };
  }

  private findPending(lane: number, timeMs: number, noteId?: string): NoteState | undefined {
    if (noteId !== undefined) {
      const exact = this.states.find((state) => state.status === 'pending' && state.note.id === noteId);
      return exact !== undefined && isTileInteractable(this.chart, exact.note, this.config.rate, timeMs)
        ? exact
        : undefined;
    }
    return this.states
      .filter((state) => state.status === 'pending'
        && state.note.lane === lane
        && isTileInteractable(this.chart, state.note, this.config.rate, timeMs))
      .sort((left, right) => Math.abs(left.note.timeMs - timeMs) - Math.abs(right.note.timeMs - timeMs)
        || left.note.timeMs - right.note.timeMs)[0];
  }

  private findReleased(lane: number, timeMs: number, noteId?: string): NoteState | undefined {
    return this.states.find((state) => {
      if (state.status !== 'active' || state.pointer !== undefined) return false;
      if (noteId !== undefined && state.note.id !== noteId) return false;
      if (noteId === undefined && Math.abs(lane - laneAt(state.note, Math.max(timeMs, state.note.timeMs))) > LANE_TOLERANCE) {
        return false;
      }
      const bounds = tileTimeBounds(this.chart, state.note, this.config.rate);
      if (timeMs > bounds.exitMs) return false;
      if (state.note.kind === 'flick') return true;
      // Reconnecting is always allowed while the remaining tail is visible.
      // The entire released gap has already lost its proportional credit.
      return true;
    });
  }

  private sample(state: NoteState, timeMs: number): void {
    if (state.note.kind === 'flick') return;
    const endMs = state.note.endTimeMs ?? state.note.timeMs;
    const until = Math.min(endMs, timeMs);
    const from = Math.max(state.note.timeMs, state.lastSample ?? state.note.timeMs);
    if (until <= from) return;
    const elapsed = until - from;
    state.sampledMs += elapsed;
    if (state.pointer !== undefined) state.coverageMs += coveredDuration(state.note, from, until, state.lastLane ?? state.note.lane);
    state.lastSample = until;
  }

  private finishSustain(state: NoteState): void {
    // Late capture must not turn a tiny remaining tail into a full-credit hold.
    // Early capture is neutral until onset; every uncovered part loses credit.
    const durationMs = Math.max(1, (state.note.endTimeMs ?? state.note.timeMs) - state.note.timeMs);
    const coverage = Math.min(1, Math.max(0, state.coverageMs / durationMs));
    const judgement: Judgement = coverage >= 0.98 ? 'perfect'
      : coverage >= 0.85 ? 'great' : coverage >= 0.5 ? 'good' : 'miss';
    this.finalize(state, judgement, coverage);
  }

  private finalize(state: NoteState, judgement: Judgement, coverage: number): void {
    if (state.status === 'done') return;
    state.status = 'done';
    state.pointer = undefined;
    state.judgement = judgement;
    this.counts[judgement] += 1;
    this.finalized += 1;
    const sustain = state.note.kind === 'hold' || state.note.kind === 'slide';
    const credit = judgement === 'miss' && !sustain ? 0 : Math.min(1, Math.max(0, coverage));
    this.earned += credit;
    if (!sustain && judgement !== 'miss' && credit < 1) {
      if ((state.errorMs ?? 0) < 0) this.early += 1;
      else if ((state.errorMs ?? 0) > 0) this.late += 1;
    }
    // Successful early/late taps keep the combo; incomplete sustains and misses break it.
    if (judgement === 'miss' || sustain && judgement !== 'perfect') {
      this.combo = 0;
    } else {
      this.combo += 1;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    }
    if (sustain || judgement === 'miss' || !state.headFeedbackSent) {
      this.feedback?.({ lane: state.note.lane, judgement, kind: state.note.kind, errorMs: state.errorMs ?? 0, combo: this.combo, phase: 'complete', credit });
    }
  }
}
