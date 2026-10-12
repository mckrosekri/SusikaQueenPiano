import { describe, expect, it } from 'vitest';
import type { Chart, Note, RunConfig } from '../types';
import { JudgementEngine, judgeTiming, laneAt, lineHitCredit, SCORING_VERSION } from './judgement';
import { tileTimeBounds } from './tile-layout';
import { effectiveApproachMs } from './tile-layout';
import { RATES } from '../types';
import { playbackView } from './playback-view';

const config: RunConfig = { difficulty: 'normal', rate: 1, practice: false, startMs: 0, loop: false };

function makeChart(notes: Note[]): Chart {
  return {
    id: 'test-chart',
    version: 'v1',
    audioHash: 'test',
    difficulty: 'normal',
    rating: 3,
    approachMs: 1_050,
    durationMs: 4_000,
    notes,
  };
}

describe('forgiving tile judgement', () => {
  it.each(RATES)('has no cooldown between rapidly released taps at %sx', rate => {
    const notes: Note[] = Array.from({ length: 40 }, (_, index) => ({ id: `rapid-${index}`, kind: 'tap', lane: index % 2,
      timeMs: 1000 + index * 20 * rate }));
    const engine = new JudgementEngine(makeChart(notes), { ...config, rate }, 'song');
    for (const note of notes) {
      expect(engine.pointerDown(1, note.lane, note.timeMs, note.id)).toBe(true);
      engine.pointerUp(1, note.timeMs);
    }
    expect(engine.counts.perfect).toBe(40);
    expect(engine.maxCombo).toBe(40);
    expect(engine.score).toBe(1_000_000);
  });
  it('an empty tap resets only the combo and does not consume a note or alter points', () => {
    const engine = new JudgementEngine(makeChart([
      { id: 'tap', kind: 'tap', lane: 0, timeMs: 1000 },
      { id: 'next', kind: 'tap', lane: 1, timeMs: 2000 },
    ]), config, 'song');
    engine.pointerDown(1, 0, 1000, 'tap');
    engine.breakCombo(3);
    expect(engine.combo).toBe(0);
    expect(engine.score).toBe(500000);
    expect(engine.counts).toEqual({ perfect: 1, great: 0, good: 0, miss: 0 });
    expect(engine.states[1].status).toBe('pending');
    engine.pointerDown(2, 1, 2000, 'next');
    expect(engine.combo).toBe(1);
    expect(engine.score).toBe(1000000);
  });

  it('resets a missed combo without taking back earned points and starts counting again', () => {
    const chart = makeChart([
      { id: 'first', kind: 'tap', lane: 0, timeMs: 1000 },
      { id: 'missed', kind: 'tap', lane: 1, timeMs: 2000 },
      { id: 'recovery', kind: 'tap', lane: 2, timeMs: 3500 },
    ]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 0, 1000, 'first');
    expect(engine.combo).toBe(1);
    const earned = engine.score;
    engine.update(tileTimeBounds(chart, chart.notes[1], 1).exitMs + 1);
    expect(engine.combo).toBe(0);
    expect(engine.score).toBe(earned);
    engine.pointerDown(2, 2, 3500, 'recovery');
    expect(engine.combo).toBe(1);
    expect(engine.maxCombo).toBe(1);
    expect(engine.score).toBeGreaterThan(earned);
  });

  it('counts a sustain only at the tail and breaks the streak on partial coverage while retaining credit', () => {
    const chart = makeChart([
      { id: 'tap', kind: 'tap', lane: 0, timeMs: 1000 },
      { id: 'dog', kind: 'hold', lane: 1, timeMs: 1500, endTimeMs: 2500 },
    ]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 0, 1000, 'tap');
    engine.pointerDown(2, 1, 1500, 'dog');
    expect(engine.combo).toBe(1);
    engine.pointerUp(2, 2400);
    engine.update(2500);
    expect(engine.counts.great).toBe(1);
    expect(engine.combo).toBe(0);
    expect(engine.score).toBe(950000);
    expect(engine.maxCombo).toBe(1);
  });

  it('keeps a flawless combo through pause and rewards a fully held dog at completion', () => {
    const chart = makeChart([
      { id: 'tap', kind: 'tap', lane: 0, timeMs: 1000 },
      { id: 'dog', kind: 'hold', lane: 1, timeMs: 1500, endTimeMs: 2500 },
    ]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 0, 1000, 'tap');
    engine.pointerDown(2, 1, 1500, 'dog');
    engine.suspend(2000);
    expect(engine.combo).toBe(1);
    engine.pointerDown(3, 1, 2000, 'dog');
    engine.update(2500);
    expect(engine.combo).toBe(2);
    expect(engine.score).toBe(1000000);
  });

  it('retains the legacy timing helper without using timing grades for tile hits', () => {
    expect(judgeTiming(-45)).toBe('perfect');
    expect(judgeTiming(46)).toBe('great');
    expect(judgeTiming(135)).toBe('good');
    expect(judgeTiming(136)).toBe('miss');
  });

  it('accepts the full visible lifetime but reserves maximum credit for the rhythm line', () => {
    const chart = makeChart([{ id: 'tap', kind: 'tap', lane: 0, timeMs: 1_000 }]);
    const early = new JudgementEngine(chart, config, 'song');
    expect(early.pointerDown(1, 3, tileTimeBounds(chart, chart.notes[0], 1).enterMs, 'tap')).toBe(true);
    expect(early.counts).toEqual({ perfect: 0, great: 0, good: 1, miss: 0 });
    expect(early.result(true).early).toBe(1);

    const late = new JudgementEngine(chart, config, 'song');
    const { exitMs } = tileTimeBounds(chart, chart.notes[0], 1);
    expect(late.pointerDown(1, 0, exitMs, 'tap')).toBe(true);
    const result = late.result(true);
    expect(result.score).toBeLessThan(1_000_000);
    expect(result.score).toBeGreaterThanOrEqual(650_000);
    expect(result.early).toBe(0);
    expect(result.late).toBe(1);
    expect(result.chartId).toBe(`${SCORING_VERSION}:test-chart`);
    const centered = new JudgementEngine(chart, config, 'song');
    centered.pointerDown(1, 0, 1000, 'tap');
    expect(centered.result(true).score).toBe(1_000_000);
  });

  it('uses the oldest visible pending tile in a lane for keyboard input', () => {
    const chart = makeChart([
      { id: 'first', kind: 'tap', lane: 1, timeMs: 1_000 },
      { id: 'second', kind: 'tap', lane: 1, timeMs: 1_200 },
    ]);
    const engine = new JudgementEngine(chart, config, 'song');
    expect(engine.pointerDown(1, 1, tileTimeBounds(chart, chart.notes[0], 1).enterMs)).toBe(true);
    expect(engine.states[0].status).toBe('done');
    expect(engine.states[1].status).toBe('pending');
  });
  it('selects the note nearest the line for keyboard input while touch honors the clicked ID', () => {
    const chart = makeChart([{ id: 'old', kind: 'tap', lane: 0, timeMs: 1000 }, { id: 'next', kind: 'tap', lane: 0, timeMs: 1200 }]);
    const keyboard = new JudgementEngine(chart, config, 'song');
    keyboard.pointerDown(1, 0, 1200);
    expect(keyboard.states[0].status).toBe('pending');
    expect(keyboard.states[1].judgement).toBe('perfect');
    const touch = new JudgementEngine(chart, config, 'song');
    touch.pointerDown(1, 0, 1200, 'old');
    expect(touch.states[0].status).toBe('done');
    expect(touch.states[1].status).toBe('pending');
  });
  it('routes a released slide through its exact ID in the current destination lane', () => {
    const chart = makeChart([{ id: 'slide', kind: 'slide', lane: 0, timeMs: 1000, endTimeMs: 2200, targetLane: 2,
      path: [{ timeMs: 1000, lane: 0 }, { timeMs: 1500, lane: 1 }, { timeMs: 2200, lane: 2 }] }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 0, 1000, 'slide'); engine.pointerUp(1, 1200);
    const target = engine.keyboardTarget(1, 1500);
    expect(target?.note.id).toBe('slide');
    expect(engine.pointerDown(2, 1, 1500, target?.note.id)).toBe(true);
    expect(engine.states[0].pointer).toBe(2);
    expect(engine.states[0].lastLane).toBe(1);
  });
  it('excludes connected active notes from keyboard candidates and has no target on an empty lane', () => {
    const engine = new JudgementEngine(makeChart([{ id: 'flick', kind: 'flick', lane: 0, timeMs: 1000, direction: 1 },
      { id: 'next', kind: 'tap', lane: 0, timeMs: 1400 }]), config, 'song');
    engine.pointerDown(1, 0, 1000, 'flick');
    expect(engine.keyboardTarget(0, 1400)?.note.id).toBe('next');
    expect(engine.keyboardTarget(3, 1400)).toBeUndefined();
    expect(engine.states[0].pointer).toBe(1);
  });
  it('scores center distance symmetrically and monotonically at every speed, with a forgiving full-credit band', () => {
    const chart = makeChart([{ id: 'tap', kind: 'tap', lane: 0, timeMs: 1500 }]);
    for (const rate of RATES) {
      const approach = effectiveApproachMs(chart, rate);
      expect(lineHitCredit(chart, rate, 0)).toBe(1);
      expect(lineHitCredit(chart, rate, approach * .04)).toBe(1);
      let previous = 1;
      for (const distance of [.05, .1, .2, .4, .7]) {
        const credit = lineHitCredit(chart, rate, distance * approach);
        expect(credit).toBeLessThan(previous);
        expect(credit).toBe(lineHitCredit(chart, rate, -distance * approach));
        expect(credit).toBeGreaterThanOrEqual(.65);
        previous = credit;
      }
      const onBeat = new JudgementEngine(chart, { ...config, rate }, 'song');
      const view = playbackView(1500 + 120 * rate, 0, 120, rate, false);
      onBeat.pointerDown(1, 0, view.timeMs, 'tap');
      expect(onBeat.result(true).score).toBe(1000000);
    }
  });
  it('retains successful early/late points and combos without calling them missed notes', () => {
    const chart = makeChart([{ id: 'early', kind: 'tap', lane: 0, timeMs: 1000 }, { id: 'late', kind: 'tap', lane: 1, timeMs: 2000 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 0, 750, 'early'); engine.pointerUp(1, 750);
    engine.pointerDown(2, 1, 2250, 'late');
    expect(engine.combo).toBe(2);
    expect(engine.counts.miss).toBe(0);
    const result = engine.result(true);
    expect(result.early).toBe(1); expect(result.late).toBe(1);
    expect(result.score).toBeGreaterThan(900000); expect(result.score).toBeLessThan(1000000);
  });
  it('keeps a flick head timing grade through its later directional completion', () => {
    const chart = makeChart([{ id: 'f', kind: 'flick', lane: 0, timeMs: 1000, direction: 1 }]);
    const centered = new JudgementEngine(chart, config, 'song');
    centered.pointerDown(1, 0, 1000, 'f'); centered.pointerMove(1, .4, 1300);
    expect(centered.result(true).score).toBe(1000000);
    const early = new JudgementEngine(chart, config, 'song');
    early.pointerDown(1, 0, 700, 'f'); early.pointerMove(1, .4, 1000);
    expect(early.result(true).score).toBeLessThan(1000000);
    expect(early.result(true).early).toBe(1);
  });

  it('rejects invisible or unknown targets and expires only after the tile leaves', () => {
    const chart = makeChart([{ id: 'tap', kind: 'tap', lane: 0, timeMs: 1_000 }]);
    const note = chart.notes[0];
    const bounds = tileTimeBounds(chart, note, 1);
    const engine = new JudgementEngine(chart, config, 'song');
    expect(engine.pointerDown(1, 0, bounds.enterMs - 1, 'tap')).toBe(false);
    expect(engine.pointerDown(1, 0, bounds.enterMs, 'unknown')).toBe(false);
    engine.update(bounds.exitMs);
    expect(engine.counts.miss).toBe(0);
    engine.update(bounds.exitMs + 1);
    expect(engine.counts.miss).toBe(1);
  });

  it('allows an early hold head, a brief release, and a regrab through the tail', () => {
    const chart = makeChart([{ id: 'hold', kind: 'hold', lane: 1, timeMs: 1_500, endTimeMs: 2_500 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    expect(engine.pointerDown(1, 1, tileTimeBounds(chart, chart.notes[0], 1).enterMs + 50, 'hold')).toBe(true);
    engine.update(1_800);
    engine.pointerUp(1, 1_800);
    engine.update(1_900);
    expect(engine.pointerDown(2, 1, 1_950, 'hold')).toBe(true);
    engine.update(2_500);
    expect(engine.counts.great).toBe(1);
    expect(engine.score).toBe(850_000);
    expect(engine.counts.miss).toBe(0);
  });

  it('requires a released hold to be regrabbed before the tail', () => {
    const chart = makeChart([{ id: 'hold', kind: 'hold', lane: 1, timeMs: 1_500, endTimeMs: 2_500 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 1, 1_000, 'hold');
    engine.update(1_800);
    engine.pointerUp(1, 1_800);
    engine.update(2_500);
    expect(engine.counts.miss).toBe(1);
  });

  it('lets a sustained tile resume after pause without consuming release grace', () => {
    const chart = makeChart([{ id: 'hold', kind: 'hold', lane: 1, timeMs: 1_500, endTimeMs: 2_500 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 1, 1_200, 'hold');
    engine.update(1_900);
    engine.suspend(1_900);
    engine.update(1_850);
    expect(engine.counts.miss).toBe(0);
    expect(engine.pointerDown(2, 1, 1_900, 'hold')).toBe(true);
    engine.update(2_500);
    expect(engine.counts.perfect).toBe(1);
  });

  it('requires the authored flick direction but accepts it anywhere while visible', () => {
    const chart = makeChart([{ id: 'flick', kind: 'flick', lane: 1, timeMs: 1_000, direction: 1, targetLane: 2 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    expect(engine.pointerDown(1, 1, 300, 'flick')).toBe(true);
    engine.pointerMove(1, 0.5, 350);
    expect(engine.counts.perfect).toBe(0);
    const { exitMs } = tileTimeBounds(chart, chart.notes[0], 1);
    engine.pointerMove(1, 1.4, exitMs);
    expect(engine.counts.good).toBe(1);

    const missed = new JudgementEngine(chart, config, 'song');
    missed.pointerDown(1, 1, 300, 'flick');
    missed.pointerUp(1, 350);
    missed.update(exitMs);
    expect(missed.counts.miss).toBe(0);
    missed.update(exitMs + 1);
    expect(missed.counts.miss).toBe(1);
  });

  it('treats early slide holding as neutral and evaluates the authored path after onset', () => {
    const slide: Note = {
      id: 'slide',
      kind: 'slide',
      lane: 0,
      timeMs: 1_000,
      endTimeMs: 2_000,
      targetLane: 2,
      direction: 1,
      path: [
        { lane: 0, timeMs: 1_000 },
        { lane: 0, timeMs: 1_500 },
        { lane: 2, timeMs: 2_000 },
      ],
    };
    const engine = new JudgementEngine(makeChart([slide]), config, 'song');
    engine.pointerDown(1, 0, 300, 'slide');
    engine.update(1_500);
    engine.pointerMove(1, 1, 1_750);
    engine.update(2_000);
    expect(engine.counts.great).toBe(1);
    expect(engine.score).toBe(890_000);
    expect(laneAt(slide, 1_750)).toBe(1);
  });

  it('never tracks more than two simultaneous fingers', () => {
    const chart = makeChart([0, 1, 2].map((lane) => ({
      id: `hold-${lane}`,
      kind: 'hold' as const,
      lane,
      timeMs: 1_000,
      endTimeMs: 2_000,
    })));
    const engine = new JudgementEngine(chart, config, 'song');
    expect(engine.pointerDown(1, 0, 500, 'hold-0')).toBe(true);
    expect(engine.pointerDown(2, 1, 500, 'hold-1')).toBe(true);
    expect(engine.pointerDown(3, 2, 500, 'hold-2')).toBe(false);
  });

  it('counts held tap pointers toward the same two-finger limit', () => {
    const chart = makeChart([0, 1, 2].map((lane) => ({
      id: `tap-${lane}`,
      kind: 'tap' as const,
      lane,
      timeMs: 1_000,
    })));
    const engine = new JudgementEngine(chart, config, 'song');
    expect(engine.pointerDown(1, 0, 500, 'tap-0')).toBe(true);
    expect(engine.pointerDown(2, 1, 500, 'tap-1')).toBe(true);
    expect(engine.pointerDown(3, 2, 500, 'tap-2')).toBe(false);
    engine.pointerUp(1, 600);
    expect(engine.pointerDown(3, 2, 600, 'tap-2')).toBe(true);
  });

  it.each([0.75, 1, 1.25, 1.5] as const)('gives full dog credit only for its full authored duration at %sx', (rate) => {
    const chart = makeChart([{ id: 'dog', kind: 'hold', lane: 1, timeMs: 1_000, endTimeMs: 2_000 }]);
    const engine = new JudgementEngine(chart, { ...config, rate }, 'song');
    engine.pointerDown(1, 1, 950, 'dog');
    engine.update(2_000);
    expect(engine.score).toBe(1_000_000);
    expect(engine.counts.perfect).toBe(1);
  });

  it.each([0, 50, 500, 700, 850, 990])('awards exactly %sms of dog credit without a tap bonus', (heldMs) => {
    const chart = makeChart([{ id: 'dog', kind: 'hold', lane: 1, timeMs: 1_000, endTimeMs: 2_000 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 1, 1_000, 'dog');
    engine.pointerUp(1, 1_000 + heldMs);
    engine.update(2_000);
    expect(engine.score).toBe(heldMs * 1_000);
    expect(engine.accuracy).toBeCloseTo(heldMs / 10);
    if (heldMs < 980) expect(engine.counts.perfect).toBe(0);
  });

  it('does not award points for briefly tapping a dog before its musical onset', () => {
    const chart = makeChart([{ id: 'dog', kind: 'hold', lane: 1, timeMs: 1_000, endTimeMs: 2_000 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 1, 600, 'dog');
    engine.pointerUp(1, 650);
    engine.update(2_000);
    expect(engine.score).toBe(0);
  });

  it('does not promote a late tail capture to full credit', () => {
    const chart = makeChart([{ id: 'dog', kind: 'hold', lane: 1, timeMs: 1_000, endTimeMs: 2_000 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 1, 1_900, 'dog');
    engine.update(2_000);
    expect(engine.score).toBe(100_000);
    expect(engine.counts.miss).toBe(1);
  });

  it('deducts only the released gap when a dog is regrabbed in time', () => {
    const chart = makeChart([{ id: 'dog', kind: 'hold', lane: 1, timeMs: 1_000, endTimeMs: 2_000 }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 1, 900, 'dog');
    engine.pointerUp(1, 1_500);
    engine.pointerDown(2, 1, 1_600, 'dog');
    engine.update(2_000);
    expect(engine.score).toBe(900_000);
    expect(engine.counts.great).toBe(1);
  });

  it('deducts time held in the wrong lane without losing valid slide credit', () => {
    const chart = makeChart([{ id: 'slide', kind: 'slide', lane: 1, timeMs: 1_000, endTimeMs: 2_000,
      path: [{ lane: 1, timeMs: 1_000 }, { lane: 1, timeMs: 2_000 }] }]);
    const engine = new JudgementEngine(chart, config, 'song');
    engine.pointerDown(1, 1, 900, 'slide');
    engine.pointerMove(1, 3, 1_400);
    engine.pointerMove(1, 1, 1_600);
    engine.update(2_000);
    expect(engine.score).toBe(800_000);
    expect(engine.counts.good).toBe(1);
  });

  it('allows a long released gap to reconnect while deducting every missing millisecond', () => {
    const engine = new JudgementEngine(makeChart([{ id: 'dog', kind: 'hold', lane: 1, timeMs: 1_000, endTimeMs: 2_000 }]), config, 'song');
    engine.pointerDown(1, 1, 900, 'dog');
    engine.pointerUp(1, 1_300);
    engine.update(1_600);
    expect(engine.pointerDown(2, 1, 1_700, 'dog')).toBe(true);
    engine.update(2_000);
    expect(engine.score).toBe(600_000);
  });

  it.each([[499, 'miss'], [500, 'good'], [849, 'good'], [850, 'great'], [979, 'great'], [980, 'perfect']] as const)(
    'grades %sms coverage as %s without rounding points upward', (heldMs, judgement) => {
      const engine = new JudgementEngine(makeChart([{ id: 'dog', kind: 'hold', lane: 1, timeMs: 1_000, endTimeMs: 2_000 }]), config, 'song');
      engine.pointerDown(1, 1, 1_000, 'dog');
      engine.pointerUp(1, 1_000 + heldMs);
      engine.update(2_000);
      expect(engine.states[0].judgement).toBe(judgement);
      expect(engine.score).toBe(heldMs * 1_000);
    });

  it('integrates slide coverage across a stalled frame instead of crediting its midpoint', () => {
    const engine = new JudgementEngine(makeChart([{ id: 'slide', kind: 'slide', lane: 0, timeMs: 1_000, endTimeMs: 2_000,
      path: [{ lane: 0, timeMs: 1_000 }, { lane: 2, timeMs: 2_000 }] }]), config, 'song');
    engine.pointerDown(1, 1, 900, 'slide');
    engine.update(2_000);
    expect(engine.score).toBe(780_000);
    expect(engine.counts.good).toBe(1);
  });
});
