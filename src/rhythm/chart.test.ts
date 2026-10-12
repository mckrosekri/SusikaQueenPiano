import { describe, expect, it } from 'vitest';

import { RATES, type BeatAnalysis, type Chart, type Difficulty, type Note } from '../types';
import { generateChart, generateCharts, validateChart } from './chart';

function musicalAnalysis(): BeatAnalysis {
  const durationMs = 20_000;
  const beatsMs = Array.from({ length: 24 }, (_, index) => 250 + index * 800);
  const onsets = beatsMs.flatMap((timeMs) => [
    { timeMs, strength: 1 },
    { timeMs: timeMs + 200, strength: 0.5 },
    { timeMs: timeMs + 400, strength: 0.7 },
    { timeMs: timeMs + 600, strength: 0.25 },
  ]);
  return {
    version: 'fixture-v2',
    audioHash: 'fixture-audio-hash',
    durationMs,
    bpm: 75,
    beatsMs,
    onsets,
    energy: Array.from({ length: durationMs / 50 }, (_, index) => 0.62 + 0.18 * Math.sin(index / 13)),
    confidence: 0.91,
    warnings: [],
    intensity: 0.78,
    activity: [{ startMs: 0, endMs: durationMs }],
    sustains: beatsMs
      .filter((_, index) => index % 6 === 2)
      .map((startMs, index) => ({ startMs, endMs: startMs + 400 + index * 40, confidence: 0.9 })),
  };
}

function focusedAnalysis(overrides: Partial<BeatAnalysis> = {}): BeatAnalysis {
  return {
    version: 'focused-v2',
    audioHash: 'focused-audio',
    durationMs: 5_000,
    bpm: 120,
    beatsMs: Array.from({ length: 10 }, (_, index) => 500 + index * 500),
    onsets: [{ timeMs: 570, strength: 1 }, { timeMs: 1_070, strength: 1 }],
    energy: new Array(100).fill(0.7),
    confidence: 0.9,
    warnings: [],
    intensity: 0.7,
    activity: [{ startMs: 0, endMs: 5_000 }],
    ...overrides,
  };
}

function moveCount(chart: Chart): number {
  return chart.notes.filter((note) => note.kind === 'flick' || note.kind === 'slide' || note.kind === 'hold').length;
}

describe('chart generation', () => {
  it('is deterministic, versioned, and unique by difficulty', () => {
    const analysis = musicalAnalysis();
    const first = generateCharts(analysis);
    const second = generateCharts(analysis);

    expect(first).toEqual(second);
    expect(new Set(Object.values(first).map((chart) => chart.id)).size).toBe(4);
    expect(Object.values(first).every((chart) => chart.version === 'afterbeat-chart-v6')).toBe(true);
    expect(Object.values(first).every((chart) => chart.id.startsWith('chart-v6-'))).toBe(true);
  });

  it('increases density from progressively weaker measured attacks', () => {
    const charts = generateCharts(musicalAnalysis());
    const order: Difficulty[] = ['easy', 'normal', 'hard', 'expert'];
    const counts = order.map((difficulty) => charts[difficulty].notes.length);

    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
    expect(counts[2]).toBeLessThan(counts[3]);
    expect(moveCount(charts.hard)).toBeGreaterThan(0);
    expect(moveCount(charts.expert)).toBeGreaterThan(0);
  });

  it('keeps off-grid note times on exact measured onsets and never emits grid-only notes', () => {
    const analysis = focusedAnalysis();
    const chart = generateChart(analysis, 'expert');
    const onsetTimes = new Set(analysis.onsets.map((onset) => onset.timeMs));

    expect(chart.notes.length).toBeGreaterThan(0);
    expect(chart.notes.every((note) => onsetTimes.has(note.timeMs))).toBe(true);
    expect(chart.notes.some((note) => note.timeMs === 570)).toBe(true);
    expect(chart.notes.some((note) => analysis.beatsMs.includes(note.timeMs))).toBe(false);
  });

  it('does not place notes on detected attacks outside audible activity', () => {
    const analysis = focusedAnalysis({
      onsets: [
        { timeMs: 500, strength: 1 },
        { timeMs: 1_500, strength: 1 },
        { timeMs: 2_500, strength: 1 },
      ],
      activity: [{ startMs: 400, endMs: 600 }, { startMs: 2_400, endMs: 2_600 }],
    });
    const chart = generateChart(analysis, 'expert');

    expect(new Set(chart.notes.map((note) => note.timeMs))).toEqual(new Set([500, 2_500]));
  });

  it('uses measured sustain endpoints and preserves their variation', () => {
    const analysis = focusedAnalysis({
      durationMs: 35_000,
      beatsMs: Array.from({ length: 69 }, (_, index) => 500 + index * 500),
      onsets: Array.from({ length: 61 }, (_, index) => ({ timeMs: 500 + index * 500,
        strength: index === 0 ? 1 : index === 13 ? 0.95 : 0.3 })).filter(onset => onset.timeMs !== 7_500),
      activity: [{ startMs: 0, endMs: 35_000 }],
      sustains: [
        { startMs: 520, endMs: 950, confidence: 0.9 },
        { startMs: 6_970, endMs: 7_850, confidence: 0.86 },
      ],
    });
    const holds = generateChart(analysis, 'normal').notes.filter((note) => note.kind === 'hold');

    expect(holds.map((note) => [note.timeMs, note.endTimeMs])).toEqual([[500, 950], [7_000, 7_850]]);
  });

  it('caps measured sustains at 1350 source milliseconds and validates every playback rate', () => {
    const analysis = focusedAnalysis({
      onsets: [{ timeMs: 500, strength: 1 }],
      sustains: [{ startMs: 500, endMs: 3_000, confidence: 0.95 }],
    });
    const chart = generateChart(analysis, 'normal');
    const hold = chart.notes.find((note) => note.kind === 'hold');

    expect(hold?.endTimeMs).toBe(1_850);
    for (const rate of RATES) expect(validateChart(chart, rate)).toEqual([]);
  });

  it('keeps absent, short, or uncertain sustain evidence as taps', () => {
    const cases: Array<BeatAnalysis['sustains']> = [
      undefined,
      [{ startMs: 570, endMs: 1_000, confidence: 0.64 }],
      [{ startMs: 570, endMs: 800, confidence: 0.95 }],
    ];
    for (const sustains of cases) {
      const notes = generateChart(focusedAnalysis({ onsets: [{ timeMs: 570, strength: 1 }], sustains }), 'normal').notes;
      expect(notes).toHaveLength(1);
      expect(notes[0].kind).toBe('tap');
    }
  });

  it('loads legacy analysis conservatively without fabricating sustained gestures', () => {
    const legacy = focusedAnalysis();
    delete legacy.activity;
    delete legacy.sustains;
    const chart = generateChart(legacy, 'expert');
    const onsetTimes = new Set(legacy.onsets.map((onset) => onset.timeMs));

    expect(chart.notes.length).toBeGreaterThan(0);
    expect(chart.notes.every((note) => onsetTimes.has(note.timeMs))).toBe(true);
    expect(chart.notes.every((note) => note.kind === 'tap' || note.kind === 'flick')).toBe(true);
  });

  it('produces four-lane, two-touch charts valid at every playback rate', () => {
    for (const chart of Object.values(generateCharts(musicalAnalysis()))) {
      expect(chart.notes.every((note) => note.lane >= 0 && note.lane <= 3)).toBe(true);
      for (const rate of RATES) expect(validateChart(chart, rate)).toEqual([]);
    }
  });

  it('does not invent notes for silent analysis', () => {
    const analysis = focusedAnalysis({
      audioHash: 'silent',
      beatsMs: [],
      onsets: [],
      energy: [],
      confidence: 0,
      intensity: 0,
      activity: [],
      warnings: ['silence_or_no_onsets'],
    });
    expect(generateChart(analysis, 'expert').notes).toEqual([]);
  });

  it('retains lower difficulty attacks and their tap lanes in a shared musical skeleton', () => {
    const analysis = musicalAnalysis();
    analysis.sustains = [];
    const charts = generateCharts(analysis);
    for (let i = 1; i < 4; i += 1) {
      const lower = charts[(['easy', 'normal', 'hard', 'expert'] as const)[i - 1]];
      const higher = charts[(['easy', 'normal', 'hard', 'expert'] as const)[i]];
      for (const note of lower.notes.filter(note => note.kind === 'tap')) {
        // Chord accents may add a second lane, but the underlying pulse stays.
        expect(higher.notes.some(other => other.timeMs === note.timeMs)).toBe(true);
      }
      for (const timeMs of new Set(lower.notes.map(note => note.timeMs))) {
        expect(lower.notes.some(note => note.timeMs === timeMs && higher.notes.some(other => other.timeMs === timeMs && other.lane === note.lane))).toBe(true);
      }
    }
  });

  it('keeps repeating strong attacks as taps even when a detector labels their background as sustained', () => {
    const analysis = musicalAnalysis();
    analysis.sustains = analysis.onsets.map(onset => ({ startMs: onset.timeMs, endMs: onset.timeMs + 1_000, confidence: 0.99 }));
    for (const chart of Object.values(generateCharts(analysis))) {
      const holds = chart.notes.filter(note => note.kind === 'hold' || note.kind === 'slide');
      // A final sustained outro can still be legitimate after the repeated attacks end.
      expect(holds.every(note => note.timeMs >= analysis.onsets.at(-1)!.timeMs - 1_000)).toBe(true);
      expect(chart.notes.filter(note => note.kind === 'tap').length / chart.notes.length).toBeGreaterThan(0.9);
    }
  });

  it('limits and spaces long gestures instead of mapping every detected tonal region', () => {
    const analysis = focusedAnalysis({ durationMs: 120_000, bpm: 120,
      onsets: Array.from({ length: 120 }, (_, i) => ({ timeMs: 500 + i * 950, strength: 0.5 + (i % 8) / 16 })),
      beatsMs: Array.from({ length: 240 }, (_, i) => i * 500),
      activity: [{ startMs: 0, endMs: 120_000 }] });
    analysis.sustains = analysis.onsets.map(onset => ({ startMs: onset.timeMs, endMs: onset.timeMs + 600, confidence: 0.95 }));
    const limits = { normal: 0.04, hard: 0.05, expert: 0.06 };
    for (const difficulty of ['normal', 'hard', 'expert'] as const) {
      const chart = generateChart(analysis, difficulty);
      const holds = chart.notes.filter(note => note.kind === 'hold' || note.kind === 'slide');
      const events = new Set(chart.notes.map(note => note.timeMs)).size;
      expect(holds.length).toBeLessThanOrEqual(Math.max(1, Math.floor(events * limits[difficulty])));
      const spacingMs = { normal: 4_000, hard: 3_000, expert: 2_000 }[difficulty];
      for (let i = 1; i < holds.length; i += 1) expect(holds[i].timeMs - holds[i - 1].timeMs).toBeGreaterThanOrEqual(spacingMs);
    }
  });

  it('authors conservative multi-lane slides and reserves every swept lane', () => {
    const onsets = Array.from({ length: 18 }, (_, index) => ({
      timeMs: 500 + index * 2_500,
      strength: 1 - index * 0.01,
    }));
    const analysis = focusedAnalysis({
      durationMs: 47_000,
      beatsMs: Array.from({ length: 94 }, (_, index) => index * 500),
      onsets,
      activity: [{ startMs: 0, endMs: 47_000 }],
      sustains: onsets.map(({ timeMs }) => ({ startMs: timeMs, endMs: timeMs + 1_200, confidence: 0.95 })),
    });

    for (const difficulty of ['hard', 'expert'] as const) {
      const chart = generateChart(analysis, difficulty);
      const slide = chart.notes.find((note) => note.kind === 'slide' && Math.abs((note.targetLane ?? note.lane) - note.lane) >= 2);
      expect(slide, `${difficulty} should contain a multi-lane slide`).toBeDefined();
      const minimumLane = Math.min(slide!.lane, slide!.targetLane!);
      const maximumLane = Math.max(slide!.lane, slide!.targetLane!);
      const sweptLanes = new Set(Array.from({ length: maximumLane - minimumLane + 1 }, (_, index) => minimumLane + index));
      const overlappingFollowers = chart.notes.filter((note) => note !== slide
        && note.timeMs > slide!.timeMs
        && note.timeMs < slide!.endTimeMs!);

      expect(slide!.path?.[0]).toEqual({ timeMs: slide!.timeMs, lane: slide!.lane });
      expect(slide!.path?.at(-1)).toEqual({ timeMs: slide!.endTimeMs, lane: slide!.targetLane });
      expect(overlappingFollowers.every((note) => !sweptLanes.has(note.lane))).toBe(true);
      for (const rate of RATES) expect(validateChart(chart, rate)).toEqual([]);
    }
  });
});

describe('validateChart', () => {
  it('finds a third touch, lane conflict, and impossible movement', () => {
    const notes: Note[] = [
      { id: 'hold', kind: 'hold', lane: 0, timeMs: 500, endTimeMs: 1_500 },
      { id: 'tap-a', kind: 'tap', lane: 1, timeMs: 700 },
      { id: 'tap-b', kind: 'tap', lane: 2, timeMs: 700 },
      {
        id: 'slide',
        kind: 'slide',
        lane: 3,
        timeMs: 1_700,
        endTimeMs: 1_800,
        targetLane: 0,
        direction: -1,
        path: [
          { timeMs: 1_700, lane: 3 },
          { timeMs: 1_800, lane: 0 },
        ],
      },
    ];
    const chart: Chart = {
      id: 'invalid',
      version: 'test',
      audioHash: 'test',
      difficulty: 'expert',
      notes,
      rating: 1,
      approachMs: 800,
      durationMs: 2_000,
    };
    const errors = validateChart(chart, 1.5);

    expect(errors.some((error) => error.startsWith('more_than_two_touches'))).toBe(true);
    expect(errors.some((error) => error.startsWith('impossible_sustain_duration:slide'))).toBe(true);
    expect(errors.some((error) => error.startsWith('impossible_slide_segment'))).toBe(true);
  });
});
