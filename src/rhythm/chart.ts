import { DIFFICULTIES, type BeatAnalysis, type Chart, type Difficulty, type Note } from '../types';
import { ARRANGEMENT_VERSION, enforceTwoFingerBudget, requiredTouchEnd } from './touch-budget';

export const CHART_VERSION = ARRANGEMENT_VERSION;

interface DifficultyPlan {
  minGapMs: number;
  onsetThreshold: number;
  onsetPercentile: number;
  chordShare: number;
  flickShare: number;
  sustainShare: number;
  sustainSpacingBeats: number;
  approachMs: number;
  ratingBase: number;
}

const PLANS: Record<Difficulty, DifficultyPlan> = {
  easy: {
    minGapMs: 520,
    onsetThreshold: 0.15,
    onsetPercentile: 0.75,
    chordShare: 0,
    flickShare: 0,
    sustainShare: 0,
    sustainSpacingBeats: 0,
    approachMs: 1_250,
    ratingBase: 2,
  },
  normal: {
    minGapMs: 240,
    onsetThreshold: 0.1,
    onsetPercentile: 0.5,
    chordShare: 0.03,
    flickShare: 0,
    sustainShare: 0.04,
    sustainSpacingBeats: 8,
    approachMs: 1_050,
    ratingBase: 5,
  },
  hard: {
    minGapMs: 185,
    onsetThreshold: 0.07,
    onsetPercentile: 0.25,
    chordShare: 0.06,
    flickShare: 0.03,
    sustainShare: 0.05,
    sustainSpacingBeats: 6,
    approachMs: 900,
    ratingBase: 8,
  },
  expert: {
    minGapMs: 135,
    onsetThreshold: 0.04,
    onsetPercentile: 0,
    chordShare: 0.09,
    flickShare: 0.04,
    sustainShare: 0.06,
    sustainSpacingBeats: 4,
    approachMs: 760,
    ratingBase: 11,
  },
};

const LANE_PATTERN = [0, 2, 1, 3, 1, 2, 0, 3] as const;
const MAX_SHORT_TILE_SOURCE_MS = 324;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function seedNumber(value: string): number {
  return Number.parseInt(stableHash(value), 36) >>> 0;
}

function isActiveAt(analysis: BeatAnalysis, timeMs: number): boolean {
  if (analysis.activity === undefined) return true;
  return analysis.activity.some((region) => region.startMs <= timeMs && timeMs <= region.endMs);
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(fraction) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const mix = index - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function nearestGridDistance(analysis: BeatAnalysis, timeMs: number, difficulty: Difficulty): number {
  if (analysis.beatsMs.length === 0) return Number.POSITIVE_INFINITY;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < analysis.beatsMs.length; index += 1) {
    distance = Math.min(distance, Math.abs(timeMs - analysis.beatsMs[index]));
    if (difficulty === 'hard' || difficulty === 'expert') {
      const next = analysis.beatsMs[index + 1];
      if (next !== undefined) distance = Math.min(distance, Math.abs(timeMs - (analysis.beatsMs[index] + next) / 2));
    }
  }
  return distance;
}

function candidateTimes(analysis: BeatAnalysis, difficulty: Difficulty): number[] {
  if (analysis.durationMs <= 0 || analysis.onsets.length === 0) return [];
  const plan = PLANS[difficulty];
  const beatLengthMs = clamp(60_000 / (analysis.bpm || 120), 300, 1_000);
  const candidates: Array<{ timeMs: number; priority: number }> = [];
  const eligibleOnsets = analysis.onsets.filter((onset) => (
    onset.strength > 0
    && onset.timeMs >= 180
    && onset.timeMs <= analysis.durationMs - 120
    && isActiveAt(analysis, onset.timeMs)
  ));
  const strengths = eligibleOnsets.map((onset) => onset.strength);
  const strongest = Math.max(0, ...strengths);
  const relativeThreshold = percentile(strengths, plan.onsetPercentile);
  const onsetThreshold = Math.min(strongest, Math.max(plan.onsetThreshold, relativeThreshold));

  // Judge attacks relative to their phrase as well as the entire recording, so a
  // quiet melody is not erased merely because a later chorus is much louder.
  const phraseMs = beatLengthMs * 8;
  const phraseStrengths = new Map<number, number[]>();
  for (const onset of eligibleOnsets) {
    const phrase = Math.floor(onset.timeMs / phraseMs);
    const values = phraseStrengths.get(phrase) ?? [];
    values.push(onset.strength);
    phraseStrengths.set(phrase, values);
  }
  const phraseThresholds = new Map([...phraseStrengths].map(([phrase, values]) => [phrase,
    Math.max(plan.onsetThreshold, percentile(values, plan.onsetPercentile))]));

  for (const onset of eligibleOnsets) {
    if (onset.strength < Math.min(onsetThreshold, phraseThresholds.get(Math.floor(onset.timeMs / phraseMs)) ?? onsetThreshold)) continue;
    const gridDistance = nearestGridDistance(analysis, onset.timeMs, difficulty);
    const rhythmicFit = Number.isFinite(gridDistance) ? 1 - clamp(gridDistance / (beatLengthMs / 2)) : 0;
    candidates.push({ timeMs: onset.timeMs, priority: onset.strength * 0.82 + rhythmicFit * 0.18 });
  }

  // Prefer the strongest nearby attack. Beat proximity only ranks attacks; it never
  // creates a note or changes the measured onset timestamp.
  candidates.sort((a, b) => b.priority - a.priority || a.timeMs - b.timeMs);
  const previousDifficulty = DIFFICULTIES[DIFFICULTIES.indexOf(difficulty) - 1];
  const inherited = previousDifficulty ? candidateTimes(analysis, previousDifficulty) : [];
  const chosen: Array<{ timeMs: number; priority: number }> = inherited.map(timeMs => ({ timeMs, priority: Infinity }));
  for (const candidate of candidates) {
    if (chosen.every((existing) => Math.abs(existing.timeMs - candidate.timeMs) >= plan.minGapMs)) chosen.push(candidate);
  }
  return chosen.map((candidate) => candidate.timeMs).sort((a, b) => a - b);
}

function blockedLanes(notes: readonly Omit<Note, 'id'>[], timeMs: number): Set<number> {
  const blocked = new Set<number>();
  for (const note of notes) {
    if (note.endTimeMs === undefined || note.endTimeMs + 45 <= timeMs) continue;
    for (const lane of sweptLanes(note)) blocked.add(lane);
  }
  return blocked;
}

function sweptLanes(note: Pick<Note, 'kind' | 'lane' | 'targetLane' | 'path'>): Set<number> {
  if (note.kind !== 'slide') return new Set([note.lane]);
  const positions = [note.lane, note.targetLane, ...(note.path ?? []).map(point => point.lane)]
    .filter((lane): lane is number => lane !== undefined);
  const minimum = Math.max(0, Math.floor(Math.min(...positions)));
  const maximum = Math.min(3, Math.ceil(Math.max(...positions)));
  return new Set(Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index));
}

function activeTouches(notes: readonly Omit<Note, 'id'>[], timeMs: number): number {
  return notes.filter((note) => note.endTimeMs !== undefined && note.timeMs <= timeMs && note.endTimeMs > timeMs).length;
}

function chooseLane(
  pattern: readonly number[],
  patternOffset: number,
  noteIndex: number,
  blocked: ReadonlySet<number>,
  previousLane: number | undefined,
): number | undefined {
  for (let attempt = 0; attempt < pattern.length; attempt += 1) {
    const lane = pattern[(noteIndex + patternOffset + attempt) % pattern.length];
    if (!blocked.has(lane) && lane !== previousLane) return lane;
  }
  return [0, 1, 2, 3].find(lane => !blocked.has(lane));
}

function sustainEvidence(
  analysis: BeatAnalysis,
  difficulty: Difficulty,
  timeMs: number,
): { endTimeMs: number; confidence: number } | undefined {
  if (difficulty === 'easy' || !analysis.sustains?.length) return undefined;
  const region = analysis.sustains
    .filter((candidate) => candidate.confidence >= 0.8 && Math.abs(candidate.startMs - timeMs) <= 60)
    .sort((a, b) => b.confidence - a.confidence || Math.abs(a.startMs - timeMs) - Math.abs(b.startMs - timeMs))[0];
  if (!region) return undefined;

  const endTimeMs = Math.min(analysis.durationMs - 80, region.endMs, timeMs + 1_350);
  if (endTimeMs - timeMs < (difficulty === 'normal' ? 450 : difficulty === 'hard' ? 360 : 300)) return undefined;
  const attack = analysis.onsets.find(onset => onset.timeMs === timeMs)?.strength ?? 0;
  // Stable accompaniment underneath repeated strong attacks is not a melody hold.
  if (analysis.onsets.some(onset => onset.timeMs > timeMs + 110 && onset.timeMs < endTimeMs - 80
    && onset.strength > Math.max(0.12, attack * 0.8))) return undefined;
  return { endTimeMs, confidence: region.confidence };
}

function makeSustain(lane: number, timeMs: number, endTimeMs: number, targetLane?: number): Omit<Note, 'id'> {
  if (targetLane !== undefined) {
    const direction = Math.sign(targetLane - lane) as -1 | 1;
    const movementStart = Math.round(timeMs + (endTimeMs - timeMs) * 0.35);
    return {
      kind: 'slide',
      lane,
      timeMs,
      endTimeMs,
      targetLane,
      direction,
      path: [
        { timeMs, lane },
        { timeMs: movementStart, lane },
        { timeMs: endTimeMs, lane: targetLane },
      ],
    };
  }
  return { kind: 'hold', lane, timeMs, endTimeMs };
}

function slideTarget(
  lane: number,
  timeMs: number,
  endTimeMs: number,
  blocked: ReadonlySet<number>,
  draft: readonly Omit<Note, 'id'>[],
): number | undefined {
  const durationMs = endTimeMs - timeMs;
  const candidates: number[] = [];
  if (durationMs >= 620) candidates.push(lane <= 1 ? lane + 2 : lane - 2);
  candidates.push(lane >= 2 ? lane - 1 : lane + 1);

  return candidates.find((targetLane) => {
    if (targetLane < 0 || targetLane > 3 || targetLane === lane) return false;
    const swept = sweptLanes({ kind: 'slide', lane, targetLane });
    return [...swept].every((sweptLane) => sweptLane === lane || (
      !blocked.has(sweptLane)
      && !draft.some((previous) => sweptLanes(previous).has(sweptLane)
        && (previous.endTimeMs ?? previous.timeMs + MAX_SHORT_TILE_SOURCE_MS) > timeMs)
    ));
  });
}

function selectAccents(analysis: BeatAnalysis, times: number[], share: number, spacingMs: number,
  eligible: (timeMs: number) => boolean, minimum = 0): Set<number> {
  if (share === 0) return new Set();
  const quota = Math.max(minimum, Math.floor(times.length * share));
  const strength = new Map(analysis.onsets.map(onset => [onset.timeMs, onset.strength]));
  const ranked = times.filter(eligible).sort((a, b) => (strength.get(b) ?? 0) - (strength.get(a) ?? 0) || a - b);
  const chosen = new Set<number>();
  for (const timeMs of ranked) {
    if (chosen.size >= quota) break;
    if ([...chosen].every(previous => Math.abs(previous - timeMs) >= spacingMs)) chosen.add(timeMs);
  }
  return chosen;
}

function describeNotes(notes: readonly Omit<Note, 'id'>[]): string {
  return notes.map((note) => [
    note.kind,
    note.lane,
    note.timeMs,
    note.endTimeMs ?? '',
    note.targetLane ?? '',
    note.direction ?? '',
    note.path?.map((point) => `${point.timeMs}:${point.lane}`).join('.') ?? '',
  ].join(':')).join('|');
}

export function generateChart(analysis: BeatAnalysis, difficulty: Difficulty): Chart {
  const plan = PLANS[difficulty];
  const times = candidateTimes(analysis, difficulty);
  const pattern = LANE_PATTERN;
  const offset = seedNumber(`${analysis.audioHash}:${analysis.version}`) % pattern.length;
  const masterTimes = difficulty === 'expert' ? times : candidateTimes(analysis, 'expert');
  const canonicalLanes = new Map<number, number>();
  let previousCanonical: number | undefined;
  masterTimes.forEach((timeMs, index) => {
    const lane = chooseLane(pattern, offset, index, new Set(), previousCanonical)!;
    canonicalLanes.set(timeMs, lane);
    previousCanonical = lane;
  });
  const beatMs = clamp(60_000 / (analysis.bpm || 120), 300, 1_000);
  const sustainTimes = selectAccents(analysis, times, plan.sustainShare, beatMs * plan.sustainSpacingBeats,
    timeMs => sustainEvidence(analysis, difficulty, timeMs) !== undefined, 1);
  const chordTimes = selectAccents(analysis, times, plan.chordShare, beatMs * 2, timeMs => !sustainTimes.has(timeMs));
  const flickTimes = selectAccents(analysis, times, plan.flickShare, beatMs * 4,
    timeMs => !sustainTimes.has(timeMs) && !chordTimes.has(timeMs));
  const draft: Array<Omit<Note, 'id'>> = [];
  let previousLane: number | undefined;
  let sustainIndex = 0;

  times.forEach((timeMs, index) => {
    const blocked = blockedLanes(draft, timeMs);
    for (const recent of draft) {
      if (recent.timeMs <= timeMs && timeMs - recent.timeMs < 135) blocked.add(recent.lane);
    }
    const canonical = canonicalLanes.get(timeMs)!;
    const lane = !blocked.has(canonical) ? canonical : chooseLane(pattern, offset, index, blocked, previousLane);
    if (lane === undefined || activeTouches(draft, timeMs) >= 2) return;

    const evidence = sustainTimes.has(timeMs) ? sustainEvidence(analysis, difficulty, timeMs) : undefined;
    let note: Omit<Note, 'id'>;
    if (evidence && activeTouches(draft, timeMs) === 0) {
      const wantsSlide = (difficulty === 'hard' || difficulty === 'expert') && sustainIndex % 3 === 0;
      const targetLane = wantsSlide
        ? slideTarget(lane, timeMs, evidence.endTimeMs, blocked, draft)
        : undefined;
      note = makeSustain(lane, timeMs, evidence.endTimeMs, targetLane);
      sustainIndex += 1;
    } else if (flickTimes.has(timeMs)) {
      const direction: -1 | 1 = lane >= 2 ? -1 : 1;
      note = { kind: 'flick', lane, timeMs, direction, targetLane: lane + direction };
    } else {
      note = { kind: 'tap', lane, timeMs };
    }
    draft.push(note);
    previousLane = lane;

    const canChord = chordTimes.has(timeMs)
      && note.endTimeMs === undefined
      && activeTouches(draft, timeMs) === 0;
    if (canChord) {
      const chordBlocked = new Set(blocked);
      chordBlocked.add(lane);
      const chordLane = chooseLane(pattern, offset + 3, index + 1, chordBlocked, lane);
      if (chordLane !== undefined) draft.push({ kind: 'tap', lane: chordLane, timeMs });
    }
  });

  const playable = enforceTwoFingerBudget(draft).sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);
  const descriptor = `${CHART_VERSION}|${analysis.version}|${analysis.audioHash}|${difficulty}|${describeNotes(playable)}`;
  const revision = CHART_VERSION.replace('afterbeat-chart-', '');
  const chartId = `chart-${revision}-${difficulty}-${stableHash(descriptor)}`;
  const notes: Note[] = playable.map((note, index) => ({ ...note, id: `${chartId}-n${index.toString(36)}` }));
  const rating = Math.round((plan.ratingBase + clamp((analysis.bpm - 80) / 100) * 2 + analysis.intensity * 2) * 10) / 10;
  return {
    id: chartId,
    version: CHART_VERSION,
    audioHash: analysis.audioHash,
    difficulty,
    notes,
    rating,
    approachMs: plan.approachMs,
    durationMs: analysis.durationMs,
  };
}

export function generateCharts(analysis: BeatAnalysis): Record<Difficulty, Chart> {
  return Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, generateChart(analysis, difficulty)])) as Record<
    Difficulty,
    Chart
  >;
}

function positionAt(note: Note, timeMs: number): number {
  if (!note.path || note.path.length === 0) return note.lane;
  for (let index = 1; index < note.path.length; index += 1) {
    const previous = note.path[index - 1];
    const next = note.path[index];
    if (timeMs <= next.timeMs) {
      const ratio = clamp((timeMs - previous.timeMs) / Math.max(1, next.timeMs - previous.timeMs));
      return previous.lane + (next.lane - previous.lane) * ratio;
    }
  }
  return note.path.at(-1)?.lane ?? note.lane;
}

export function validateChart(chart: Chart, rate = 1): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(rate) || rate <= 0) return ['invalid_playback_rate'];
  if (!Number.isFinite(chart.durationMs) || chart.durationMs < 0) errors.push('invalid_chart_duration');
  if (!DIFFICULTIES.includes(chart.difficulty)) errors.push('invalid_difficulty');
  const ids = new Set<string>();
  let previousTime = -Infinity;

  for (const note of chart.notes) {
    if (ids.has(note.id)) errors.push(`duplicate_note_id:${note.id}`);
    ids.add(note.id);
    if (!Number.isInteger(note.lane) || note.lane < 0 || note.lane > 3) errors.push(`invalid_lane:${note.id}`);
    if (note.targetLane !== undefined && (!Number.isInteger(note.targetLane) || note.targetLane < 0 || note.targetLane > 3)) {
      errors.push(`invalid_target_lane:${note.id}`);
    }
    if (!Number.isFinite(note.timeMs) || note.timeMs < 0 || note.timeMs > chart.durationMs) errors.push(`invalid_time:${note.id}`);
    if (note.timeMs < previousTime) errors.push(`notes_not_sorted:${note.id}`);
    previousTime = note.timeMs;

    if (note.kind === 'hold' || note.kind === 'slide') {
      if (note.endTimeMs === undefined || !Number.isFinite(note.endTimeMs) || note.endTimeMs <= note.timeMs) {
        errors.push(`invalid_sustain_end:${note.id}`);
      } else {
        const wallDuration = (note.endTimeMs - note.timeMs) / rate;
        if (wallDuration < 180 || wallDuration > 1_800 || note.endTimeMs > chart.durationMs) {
          errors.push(`impossible_sustain_duration:${note.id}`);
        }
      }
    } else if (note.endTimeMs !== undefined) {
      errors.push(`unexpected_end_time:${note.id}`);
    }

    if (note.kind === 'flick') {
      if ((note.direction !== -1 && note.direction !== 1) || note.targetLane !== note.lane + note.direction) {
        errors.push(`invalid_flick:${note.id}`);
      }
    }

    if (note.kind === 'slide') {
      const path = note.path;
      if (!path || path.length < 2 || note.targetLane === undefined || note.endTimeMs === undefined) {
        errors.push(`invalid_slide_path:${note.id}`);
      } else {
        if (path[0].timeMs !== note.timeMs || path[0].lane !== note.lane) errors.push(`invalid_slide_start:${note.id}`);
        const last = path.at(-1)!;
        if (last.timeMs !== note.endTimeMs || last.lane !== note.targetLane) errors.push(`invalid_slide_target:${note.id}`);
        for (let index = 0; index < path.length; index += 1) {
          const point = path[index];
          if (!Number.isInteger(point.lane) || point.lane < 0 || point.lane > 3) errors.push(`invalid_slide_lane:${note.id}`);
          if (index > 0) {
            const previous = path[index - 1];
            const wallTime = (point.timeMs - previous.timeMs) / rate;
            if (point.timeMs <= previous.timeMs || wallTime < Math.abs(point.lane - previous.lane) * 70) {
              errors.push(`impossible_slide_segment:${note.id}`);
            }
          }
        }
      }
    } else if (note.path !== undefined || (note.kind !== 'flick' && note.targetLane !== undefined)) {
      errors.push(`unexpected_movement:${note.id}`);
    }
  }

  const touchEnd = (note: Note): number => note.endTimeMs ?? note.timeMs + 45 * rate;
  for (let index = 0; index < chart.notes.length; index += 1) {
    const note = chart.notes[index];
    const concurrent = chart.notes.filter((candidate) => candidate.timeMs <= note.timeMs && requiredTouchEnd(candidate, rate) > note.timeMs);
    if (concurrent.length > 2) errors.push(`more_than_two_touches:${note.id}`);
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const other = chart.notes[otherIndex];
      const overlapStart = Math.max(note.timeMs, other.timeMs);
      const overlapEnd = Math.min(touchEnd(note), touchEnd(other));
      if (note.lane === other.lane) {
        if (overlapStart < overlapEnd) errors.push(`lane_input_overlap:${note.id}`);
        const wallGap = Math.abs(note.timeMs - other.timeMs) / rate;
        if (wallGap < 90) errors.push(`same_lane_too_fast:${note.id}`);
      }
      if (note.kind === 'slide' && other.kind === 'slide' && overlapStart < overlapEnd) {
        const startDifference = positionAt(note, overlapStart) - positionAt(other, overlapStart);
        const endDifference = positionAt(note, overlapEnd) - positionAt(other, overlapEnd);
        if (startDifference === 0 || endDifference === 0 || Math.sign(startDifference) !== Math.sign(endDifference)) {
          errors.push(`conflicting_slide_paths:${note.id}`);
        }
      }
      if (overlapStart < overlapEnd && (note.kind === 'slide' || other.kind === 'slide')) {
        const moving = note.kind === 'slide' ? note : other;
        const stationary = moving === note ? other : note;
        if (stationary.kind !== 'slide') {
          const checkTime = Math.max(overlapStart, stationary.timeMs);
          if (Math.abs(positionAt(moving, checkTime) - stationary.lane) < 0.45) {
            errors.push(`movement_lane_conflict:${note.id}`);
          }
        }
      }
    }
  }

  return [...new Set(errors)];
}
