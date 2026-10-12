import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';

import { BUNDLED_SONGS } from '../src/data/catalog';
import { analyzePCM } from '../src/rhythm/analysis';
import { generateCharts, validateChart } from '../src/rhythm/chart';
import { DIFFICULTIES, RATES, type BeatAnalysis, type Chart, type Difficulty, type PlaybackRate } from '../src/types';

const SAMPLE_RATE = 22_050;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const chartsDirectory = join(projectRoot, 'public', 'charts');
const reviewPath = join(projectRoot, 'output', 'chart-review.json');

interface GapReview {
  noteCount: number;
  exactOnsetPercent: number;
  inactiveNoteCount: number;
  unsupportedSustainCount: number;
  sustainDurationsMs: number[];
  kinds: Record<string, number>;
  introGapMs: number;
  outroGapMs: number;
  longestInternalGapMs: number;
  energeticGapCount: number;
}

interface SongReview {
  songId: string;
  title: string;
  audioFile: string;
  audioHash: string;
  catalogDurationMs: number;
  decodedDurationMs: number;
  durationDeltaMs: number;
  catalogBpm: number;
  detectedBpm: number;
  bundledBpm: number;
  tempoSource: 'catalog_metadata_with_signal_fitted_phase' | 'harmonic_corrected_analyzer_with_signal_fitted_phase';
  tempoRatio: number;
  tempoComparison: 'match' | 'near' | 'half-time' | 'double-time' | 'mismatch';
  confidence: number;
  analyzerWarnings: string[];
  firstBeatMs: number | null;
  strongOnsetCount: number;
  strongOnsetOnBeatPercent: number;
  strongOnsetOnBeatOrHalfPercent: number;
  medianStrongOnsetBeatDistanceMs: number | null;
  phaseStableAcrossSong: boolean;
  phaseSegments: Array<{
    startMs: number;
    endMs: number;
    strongOnsetCount: number;
    onBeatOrHalfPercent: number | null;
    medianBeatOrHalfDistanceMs: number | null;
  }>;
  charts: Record<Difficulty, GapReview>;
  validation: Record<PlaybackRate, Record<Difficulty, string[]>>;
  status: 'verified' | 'uncertain';
  reviewNotes: string[];
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function decodeMono(audioPath: string): Float32Array {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', audioPath, '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, windowsHide: true },
  );
  if (result.error) throw new Error(`FFmpeg could not start: ${result.error.name}`);
  if (result.status !== 0) throw new Error(`FFmpeg decode failed with exit code ${result.status ?? 'unknown'}.`);
  if (!result.stdout || result.stdout.byteLength === 0 || result.stdout.byteLength % 4 !== 0) {
    throw new Error('FFmpeg returned invalid PCM output.');
  }
  return new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    result.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT,
  ).slice();
}

export function tempoComparison(detectedBpm: number, catalogBpm: number): SongReview['tempoComparison'] {
  const ratio = detectedBpm / catalogBpm;
  if (Math.abs(ratio - 1) <= 0.015) return 'match';
  if (Math.abs(ratio - 1) <= 0.04) return 'near';
  if (Math.abs(ratio - 0.5) <= 0.035) return 'half-time';
  if (Math.abs(ratio - 2) <= 0.07) return 'double-time';
  return 'mismatch';
}

function nearestDistance(timeMs: number, grid: readonly number[]): number {
  if (grid.length === 0) return Number.POSITIVE_INFINITY;
  let low = 0;
  let high = grid.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (grid[middle] < timeMs) low = middle + 1;
    else high = middle;
  }
  return Math.min(
    Math.abs(grid[low] - timeMs),
    low > 0 ? Math.abs(grid[low - 1] - timeMs) : Number.POSITIVE_INFINITY,
  );
}

function selectStrongOnsets(analysis: BeatAnalysis): BeatAnalysis['onsets'] {
  if (analysis.onsets.length === 0) return [];
  const threshold = percentile(analysis.onsets.map((onset) => onset.strength), 0.8) ?? 0;
  return analysis.onsets.filter((onset) => onset.strength >= threshold && onset.strength > 0);
}

function resolveBundledTempo(
  raw: BeatAnalysis,
  catalogBpm: number,
  comparison: SongReview['tempoComparison'],
): { bpm: number; source: SongReview['tempoSource'] } {
  const harmonicBpm = comparison === 'double-time' ? raw.bpm / 2 : comparison === 'half-time' ? raw.bpm * 2 : raw.bpm;
  if (
    (comparison === 'double-time' || comparison === 'half-time')
    && raw.confidence >= 0.45
    && Math.abs(harmonicBpm / catalogBpm - 1) <= 0.04
  ) {
    return { bpm: harmonicBpm, source: 'harmonic_corrected_analyzer_with_signal_fitted_phase' };
  }
  return { bpm: catalogBpm, source: 'catalog_metadata_with_signal_fitted_phase' };
}

export function reconcileTempo(raw: BeatAnalysis, bpm: number, comparison: SongReview['tempoComparison']): BeatAnalysis {
  const periodMs = 60_000 / bpm;
  const strong = selectStrongOnsets(raw);
  const phaseSteps = Math.max(96, Math.ceil(periodMs));
  let bestPhaseMs = raw.beatsMs[0] === undefined ? 0 : ((raw.beatsMs[0] % periodMs) + periodMs) % periodMs;
  let bestScore = -1;
  for (let step = 0; step < phaseSteps; step += 1) {
    const phaseMs = periodMs * step / phaseSteps;
    let score = 0;
    for (const onset of strong) {
      const wrapped = ((onset.timeMs - phaseMs) % periodMs + periodMs) % periodMs;
      const distance = Math.min(wrapped, periodMs - wrapped);
      score += Math.max(0.01, onset.strength ** 2) * Math.exp(-0.5 * (distance / Math.max(24, periodMs * 0.065)) ** 2);
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhaseMs = phaseMs;
    }
  }
  const beatsMs: number[] = [];
  for (let timeMs = bestPhaseMs; timeMs <= raw.durationMs; timeMs += periodMs) beatsMs.push(Math.round(timeMs));
  const warnings = [...raw.warnings, 'catalog_tempo_applied', 'source_assisted_tempo_reviewed'];
  if (comparison !== 'match') warnings.push(`raw_tempo_${comparison.replaceAll('-', '_')}`);
  return {
    ...raw,
    version: `${raw.version}-demo-catalog-v1`,
    bpm,
    beatsMs,
    warnings: [...new Set(warnings)],
  };
}

function phaseReview(analysis: BeatAnalysis): Pick<
  SongReview,
  'firstBeatMs' | 'strongOnsetCount' | 'strongOnsetOnBeatPercent' | 'strongOnsetOnBeatOrHalfPercent' | 'medianStrongOnsetBeatDistanceMs' | 'phaseStableAcrossSong' | 'phaseSegments'
> {
  const strong = selectStrongOnsets(analysis);
  const beatDistances = strong.map((onset) => nearestDistance(onset.timeMs, analysis.beatsMs));
  const halfBeats = analysis.beatsMs.flatMap((timeMs, index) => {
    const next = analysis.beatsMs[index + 1];
    return next === undefined ? [timeMs] : [timeMs, Math.round((timeMs + next) / 2)];
  });
  const beatOrHalfDistances = strong.map((onset) => nearestDistance(onset.timeMs, halfBeats));
  const phaseSegments = Array.from({ length: 8 }, (_, index) => {
    const startMs = Math.round(analysis.durationMs * index / 8);
    const endMs = Math.round(analysis.durationMs * (index + 1) / 8);
    const segmentOnsets = strong.filter((onset) => onset.timeMs >= startMs && onset.timeMs < endMs);
    const distances = segmentOnsets.map((onset) => nearestDistance(onset.timeMs, halfBeats));
    return {
      startMs,
      endMs,
      strongOnsetCount: segmentOnsets.length,
      onBeatOrHalfPercent: distances.length
        ? round(100 * distances.filter((distance) => distance <= 75).length / distances.length, 1)
        : null,
      medianBeatOrHalfDistanceMs: percentile(distances, 0.5),
    };
  });
  const supportedSegments = phaseSegments.filter((segment) => segment.strongOnsetCount >= 5);
  const phaseStableAcrossSong = supportedSegments.length >= 6 && supportedSegments.every((segment) => (
    (segment.onBeatOrHalfPercent ?? 0) >= 45 && (segment.medianBeatOrHalfDistanceMs ?? Number.POSITIVE_INFINITY) <= 90
  ));
  return {
    firstBeatMs: analysis.beatsMs[0] ?? null,
    strongOnsetCount: strong.length,
    strongOnsetOnBeatPercent: strong.length
      ? round(100 * beatDistances.filter((distance) => distance <= 75).length / strong.length, 1)
      : 0,
    strongOnsetOnBeatOrHalfPercent: strong.length
      ? round(100 * beatOrHalfDistances.filter((distance) => distance <= 75).length / strong.length, 1)
      : 0,
    medianStrongOnsetBeatDistanceMs: percentile(beatDistances, 0.5),
    phaseStableAcrossSong,
    phaseSegments,
  };
}

function averageEnergy(analysis: BeatAnalysis, startMs: number, endMs: number): number {
  if (analysis.energy.length === 0 || endMs <= startMs) return 0;
  const start = Math.max(0, Math.floor((startMs / analysis.durationMs) * analysis.energy.length));
  const end = Math.min(analysis.energy.length, Math.ceil((endMs / analysis.durationMs) * analysis.energy.length));
  if (end <= start) return 0;
  let total = 0;
  for (let index = start; index < end; index += 1) total += analysis.energy[index];
  return total / (end - start);
}

function gapReview(chart: Chart, analysis: BeatAnalysis): GapReview {
  const times = [...new Set(chart.notes.map((note) => note.timeMs))].sort((a, b) => a - b);
  const first = times[0] ?? analysis.durationMs;
  const last = times.at(-1) ?? 0;
  let longestInternalGapMs = 0;
  let energeticGapCount = 0;
  const energeticThresholdMs = Math.max(1_800, (60_000 / Math.max(60, analysis.bpm)) * 4);
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index] - times[index - 1];
    longestInternalGapMs = Math.max(longestInternalGapMs, gap);
    if (gap >= energeticThresholdMs && averageEnergy(analysis, times[index - 1], times[index]) >= 0.38) {
      energeticGapCount += 1;
    }
  }
  const kinds: Record<string, number> = { tap: 0, hold: 0, flick: 0, slide: 0 };
  chart.notes.forEach((note) => { kinds[note.kind] += 1; });
  return {
    noteCount: chart.notes.length,
    exactOnsetPercent: chart.notes.length ? round(100 * chart.notes.filter(note=>analysis.onsets.some(onset=>onset.timeMs===note.timeMs)).length/chart.notes.length,2) : 100,
    inactiveNoteCount: analysis.activity ? chart.notes.filter(note=>!analysis.activity!.some(region=>note.timeMs>=region.startMs-25 && note.timeMs<=region.endMs+25)).length : 0,
    unsupportedSustainCount: chart.notes.filter(note=>note.endTimeMs!==undefined && !analysis.sustains?.some(region=>Math.abs(region.startMs-note.timeMs)<=80 && region.endMs>=note.endTimeMs! && region.confidence>=0.6)).length,
    sustainDurationsMs: [...new Set(chart.notes.filter(note=>note.endTimeMs!==undefined).map(note=>note.endTimeMs!-note.timeMs))].sort((a,b)=>a-b),
    kinds,
    introGapMs: first,
    outroGapMs: Math.max(0, analysis.durationMs - last),
    longestInternalGapMs,
    energeticGapCount,
  };
}

function reviewNotes(
  rawAnalysis: BeatAnalysis,
  comparison: SongReview['tempoComparison'],
  phase: ReturnType<typeof phaseReview>,
  durationDeltaMs: number,
  charts: Record<Difficulty, GapReview>,
  validation: SongReview['validation'],
): string[] {
  const notes: string[] = [];
  if (comparison === 'half-time' || comparison === 'double-time') notes.push(`detected_${comparison}_versus_catalog`);
  else if (comparison === 'mismatch') notes.push('detected_tempo_disagrees_with_catalog');
  else if (comparison === 'near') notes.push('detected_tempo_near_but_not_equal_to_catalog');
  if (rawAnalysis.confidence < 0.55) notes.push('analyzer_confidence_below_0.55');
  if (phase.strongOnsetCount < 8) notes.push('too_few_strong_onsets_for_phase_review');
  if (phase.strongOnsetCount >= 8 && phase.strongOnsetOnBeatOrHalfPercent < 55) {
    notes.push('strong_onsets_weakly_aligned_to_bundled_beat_grid');
  }
  if (!phase.phaseStableAcrossSong) notes.push('beat_phase_not_stable_in_every_supported_song_segment');
  if (Math.abs(durationDeltaMs) > 500) notes.push('decoded_duration_differs_from_catalog_by_over_500ms');
  if (Object.values(charts).some((chart) => chart.energeticGapCount > 0)) notes.push('energetic_chart_gaps_detected');
  if (Object.values(validation).some((byDifficulty) => Object.values(byDifficulty).some((errors) => errors.length > 0))) {
    notes.push('chart_validation_failed');
  }
  notes.push(...rawAnalysis.warnings.map((warning) => `analyzer:${warning}`));
  return [...new Set(notes)];
}

async function main(): Promise<void> {
  await mkdir(chartsDirectory, { recursive: true });
  await mkdir(join(projectRoot, 'output'), { recursive: true });
  const reviews: SongReview[] = [];

  for (const [songIndex, song] of BUNDLED_SONGS.entries()) {
    if (!song.audioUrl) throw new Error(`${song.id}: catalog audio URL is missing.`);
    const filename = basename(decodeURIComponent(song.audioUrl));
    const audioPath = join(projectRoot, 'public', 'audio', filename);
    const bytes = await readFile(audioPath);
    const audioHash = createHash('sha256').update(bytes).digest('hex');
    process.stdout.write(`[${songIndex + 1}/${BUNDLED_SONGS.length}] ${song.title}: decoding... `);
    const pcm = decodeMono(audioPath);
    process.stdout.write('analyzing... ');
    const rawAnalysis = analyzePCM(pcm, SAMPLE_RATE, audioHash);
    const comparison = tempoComparison(rawAnalysis.bpm, song.bpm);
    const resolvedTempo = resolveBundledTempo(rawAnalysis, song.bpm, comparison);
    const analysis = reconcileTempo(rawAnalysis, resolvedTempo.bpm, comparison);
    const phase = phaseReview(analysis);
    if (!phase.phaseStableAcrossSong) analysis.warnings.push('phase_uncertain');
    const charts = generateCharts(analysis);
    const validation = Object.fromEntries(RATES.map((rate) => [
      rate,
      Object.fromEntries(DIFFICULTIES.map((difficulty) => {
        const chart = charts[difficulty];
        const errors = validateChart(chart, rate);
        if (Math.max(chart.approachMs, 650 * rate) / rate < 650) errors.push('approach_below_650ms_wall');
        return [difficulty, errors];
      })),
    ])) as SongReview['validation'];
    const chartReviews = Object.fromEntries(DIFFICULTIES.map((difficulty) => [
      difficulty,
      gapReview(charts[difficulty], analysis),
    ])) as Record<Difficulty, GapReview>;
    const durationDeltaMs = analysis.durationMs - song.durationMs;
    const notes = reviewNotes(rawAnalysis, comparison, phase, durationDeltaMs, chartReviews, validation);
    await writeFile(join(chartsDirectory, `${song.id}.json`), `${JSON.stringify(analysis)}\n`, 'utf8');
    reviews.push({
      songId: song.id,
      title: song.title,
      audioFile: filename,
      audioHash,
      catalogDurationMs: song.durationMs,
      decodedDurationMs: analysis.durationMs,
      durationDeltaMs,
      catalogBpm: song.bpm,
      detectedBpm: rawAnalysis.bpm,
      bundledBpm: analysis.bpm,
      tempoSource: resolvedTempo.source,
      tempoRatio: round(rawAnalysis.bpm / song.bpm, 4),
      tempoComparison: comparison,
      confidence: rawAnalysis.confidence,
      analyzerWarnings: rawAnalysis.warnings,
      ...phase,
      charts: chartReviews,
      validation,
      status: notes.length === 0 ? 'verified' : 'uncertain',
      reviewNotes: notes,
    });
    console.log(`raw ${rawAnalysis.bpm} / bundled ${analysis.bpm} BPM; ${rawAnalysis.confidence.toFixed(2)} confidence; ${notes.length ? 'uncertain' : 'verified'}`);
  }

  const summary = {
    schemaVersion: 2,
    methodology: 'Automated local FFT/spectral-flux analysis of FFmpeg-decoded 22.05 kHz mono PCM. Playable timestamps are measured onsets, with activity gating. Holds consume conservative stable-tonal regions and measured releases, capped for ergonomics; this does not transcribe instruments or pitches. Chords, flicks, slides and lane choices remain designed game gestures. Bundled tempo uses catalog BPM and a signal-fitted phase; raw detected tempo remains recorded. Exact-onset and sustain-support checks prove internal signal consistency, not listener-approved musical accuracy. No human listening review is claimed.',
    sampleRate: SAMPLE_RATE,
    songs: reviews,
    totals: {
      songs: reviews.length,
      verified: reviews.filter((review) => review.status === 'verified').length,
      uncertain: reviews.filter((review) => review.status === 'uncertain').length,
      validationErrors: reviews.reduce(
        (total, review) => total + Object.values(review.validation).flatMap(Object.values).reduce((sum, errors) => sum + errors.length, 0),
        0,
      ),
    },
  };
  await writeFile(reviewPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${reviews.length} analyses and ${reviewPath}.`);
}

export { main as generateDemoCharts };
if (process.argv[1]?.endsWith('generate-demo-charts.ts')) await main();
