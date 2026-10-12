import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';
type PlaybackRate = 0.75 | 1 | 1.25 | 1.5;
type NoteKind = 'tap' | 'hold' | 'flick' | 'slide';
interface Note {
  id: string; kind: NoteKind; lane: number; timeMs: number;
  endTimeMs?: number; targetLane?: number; direction?: -1 | 1;
  path?: Array<{ timeMs: number; lane: number }>;
}
interface Chart {
  id: string; version: string; audioHash: string; difficulty: Difficulty;
  notes: Note[]; rating: number; approachMs: number; durationMs: number;
}
interface BeatAnalysis {
  version: string; audioHash: string; durationMs: number; bpm: number;
  beatsMs: number[]; onsets: Array<{ timeMs: number; strength: number }>;
  energy: number[]; confidence: number; warnings: string[]; intensity: number;
  sustains?: Array<{ startMs: number; endMs: number; confidence: number }>;
  activity?: Array<{ startMs: number; endMs: number }>;
}

const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'expert'];
const RATES: PlaybackRate[] = [0.75, 1, 1.25, 1.5];

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const label = (process.env.GENERIC_AUDIT_LABEL ?? 'current').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
const jsonPath = join(projectRoot, 'output', `generic-${label}-geometry.json`);
const markdownPath = join(projectRoot, 'output', `generic-${label}-geometry.md`);
const stageWidths = [224, 320, 400, 768] as const;

const vite = await createServer({
  root: projectRoot,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, watch: null, hmr: false },
});
const chartModule = await vite.ssrLoadModule('/src/rhythm/chart.ts') as {
  generateCharts: (analysis: BeatAnalysis) => Record<Difficulty, Chart>;
  validateChart: (chart: Chart, rate: number) => string[];
};
const judgementModule = await vite.ssrLoadModule('/src/rhythm/judgement.ts') as {
  laneAt: (note: Note, timeMs: number) => number;
};
const layoutModule = await vite.ssrLoadModule('/src/rhythm/tile-layout.ts') as {
  tileDurationMs: (chart: Chart, note: Note, rate: PlaybackRate) => number;
  tileTimeBounds: (chart: Chart, note: Note, rate: PlaybackRate) => { enterMs: number; exitMs: number };
};
const { generateCharts, validateChart } = chartModule;
const { laneAt } = judgementModule;
const { tileDurationMs, tileTimeBounds } = layoutModule;

interface Collision {
  first: string;
  second: string;
  firstKind: Note['kind'];
  secondKind: Note['kind'];
  bodyOverlapMs: number;
  visibleOverlapMs: number;
  minimumLaneDistance: number;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sweptLanes(note: Note): Set<number> {
  // Flicks encode an input direction but their rectangle never moves; GameStage
  // moves a body only through laneAt(), which reads authored slide paths.
  if (note.kind !== 'slide') return new Set([note.lane]);
  const positions = [note.lane, note.targetLane, ...(note.path ?? []).map((point) => point.lane)]
    .filter((lane): lane is number => lane !== undefined);
  const minimum = Math.max(0, Math.floor(Math.min(...positions)));
  const maximum = Math.min(3, Math.ceil(Math.max(...positions)));
  return new Set(Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index));
}

function shareSweptLane(first: Note, second: Note): boolean {
  const firstLanes = sweptLanes(first);
  return [...sweptLanes(second)].some((lane) => firstLanes.has(lane));
}

function pathBreakpoints(note: Note, startMs: number, endMs: number): number[] {
  return (note.path ?? []).map((point) => point.timeMs).filter((timeMs) => timeMs > startMs && timeMs < endMs);
}

/** Exact minimum for piecewise-linear lane paths over the common visible interval. */
function minimumLaneDistance(first: Note, second: Note, startMs: number, endMs: number): number {
  const boundaries = [...new Set([
    startMs,
    ...pathBreakpoints(first, startMs, endMs),
    ...pathBreakpoints(second, startMs, endMs),
    endMs,
  ])].sort((left, right) => left - right);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < boundaries.length; index += 1) {
    const start = boundaries[index - 1];
    const end = boundaries[index];
    const startDifference = laneAt(first, start) - laneAt(second, start);
    const endDifference = laneAt(first, end) - laneAt(second, end);
    minimum = Math.min(minimum, Math.abs(startDifference), Math.abs(endDifference));
    if (startDifference === 0 || endDifference === 0 || Math.sign(startDifference) !== Math.sign(endDifference)) return 0;
  }
  return minimum;
}

function geometryReview(chart: Chart, rate: PlaybackRate, stageWidth: number) {
  const laneWidth = stageWidth / 4;
  const tileWidth = Math.max(48, laneWidth - 8);
  const horizontalCollisionThreshold = tileWidth / laneWidth;
  const body = chart.notes.map((note) => {
    const durationMs = tileDurationMs(chart, note, rate);
    const bounds = tileTimeBounds(chart, note, rate);
    return {
      note,
      startMs: note.timeMs,
      endMs: note.timeMs + durationMs,
      visibleStartMs: bounds.enterMs,
      visibleEndMs: bounds.exitMs,
    };
  }).sort((left, right) => left.startMs - right.startMs || left.note.lane - right.note.lane);
  const collisions: Collision[] = [];
  const reservationViolations: Collision[] = [];

  for (let firstIndex = 0; firstIndex < body.length; firstIndex += 1) {
    const first = body[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < body.length; secondIndex += 1) {
      const second = body[secondIndex];
      if (second.startMs >= first.endMs) break;
      const bodyOverlapMs = Math.min(first.endMs, second.endMs) - Math.max(first.startMs, second.startMs);
      if (bodyOverlapMs <= 0) continue;
      const visibleStartMs = Math.max(first.visibleStartMs, second.visibleStartMs);
      const visibleEndMs = Math.min(first.visibleEndMs, second.visibleEndMs);
      const visibleOverlapMs = visibleEndMs - visibleStartMs;
      if (visibleOverlapMs <= 0) continue;
      const laneDistance = minimumLaneDistance(first.note, second.note, visibleStartMs, visibleEndMs);
      const detail: Collision = {
        first: first.note.id,
        second: second.note.id,
        firstKind: first.note.kind,
        secondKind: second.note.kind,
        bodyOverlapMs: round(bodyOverlapMs),
        visibleOverlapMs: round(visibleOverlapMs),
        minimumLaneDistance: round(laneDistance, 4),
      };
      if (laneDistance < horizontalCollisionThreshold) collisions.push(detail);
      if (shareSweptLane(first.note, second.note)) reservationViolations.push(detail);
    }
  }

  return {
    stageWidth,
    laneWidth,
    tileWidth,
    horizontalCollisionThreshold: round(horizontalCollisionThreshold, 4),
    collisionCount: collisions.length,
    reservationViolationCount: reservationViolations.length,
    collisions: collisions.slice(0, 20),
    reservationViolations: reservationViolations.slice(0, 20),
  };
}

function activeOnsets(analysis: BeatAnalysis): number {
  return analysis.onsets.filter((onset) => onset.strength > 0
    && onset.timeMs >= 180
    && onset.timeMs <= analysis.durationMs - 120
    && (analysis.activity === undefined
      || analysis.activity.some((region) => region.startMs <= onset.timeMs && onset.timeMs <= region.endMs))).length;
}

function activeAt(analysis: BeatAnalysis, timeMs: number): boolean {
  return analysis.activity === undefined
    || analysis.activity.some((region) => region.startMs <= timeMs && timeMs <= region.endMs);
}

function activeOverlapMs(analysis: BeatAnalysis, startMs: number, endMs: number): number {
  if (analysis.activity === undefined) return Math.max(0, endMs - startMs);
  return analysis.activity.reduce((total, region) => (
    total + Math.max(0, Math.min(endMs, region.endMs) - Math.max(startMs, region.startMs))
  ), 0);
}

function activeEnergyWindows(analysis: BeatAnalysis) {
  const windowMs = 4_000;
  const sampleMs = analysis.durationMs / Math.max(1, analysis.energy.length);
  const windows = [];
  for (let startMs = 0; startMs < analysis.durationMs; startMs += windowMs) {
    const endMs = Math.min(analysis.durationMs, startMs + windowMs);
    const durationMs = endMs - startMs;
    const activeMs = activeOverlapMs(analysis, startMs, endMs);
    // Keep musical windows, including quiet verses, but exclude detected silence
    // and boundary fragments rather than treating them as low-energy structure.
    if (durationMs < 2_000 || activeMs < durationMs * 0.75) continue;
    const firstSample = Math.max(0, Math.floor(startMs / sampleMs));
    const lastSample = Math.min(analysis.energy.length, Math.ceil(endMs / sampleMs));
    const activeSamples: number[] = [];
    for (let index = firstSample; index < lastSample; index += 1) {
      const timeMs = (index + 0.5) * sampleMs;
      if (timeMs >= startMs && timeMs < endMs && activeAt(analysis, timeMs)) activeSamples.push(analysis.energy[index]);
    }
    if (activeSamples.length === 0) continue;
    windows.push({
      startMs,
      endMs,
      activeMs,
      averageEnergy: activeSamples.reduce((sum, energy) => sum + energy, 0) / activeSamples.length,
    });
  }
  return windows;
}

function densityForWindows(chart: Chart, windows: ReturnType<typeof activeEnergyWindows>) {
  const activeMinutes = windows.reduce((sum, window) => sum + window.activeMs, 0) / 60_000;
  const inWindows = (timeMs: number) => windows.some((window) => timeMs >= window.startMs && timeMs < window.endMs);
  const eventTimes = new Set(chart.notes.filter((note) => inWindows(note.timeMs)).map((note) => note.timeMs));
  const tapNotes = chart.notes.filter((note) => note.kind === 'tap' && inWindows(note.timeMs)).length;
  return {
    windows: windows.length,
    activeSeconds: round(activeMinutes * 60),
    averageEnergy: round(windows.reduce((sum, window) => sum + window.averageEnergy, 0) / Math.max(1, windows.length), 4),
    eventsPerMinute: round(eventTimes.size / Math.max(activeMinutes, 1 / 60_000)),
    tapNotesPerMinute: round(tapNotes / Math.max(activeMinutes, 1 / 60_000)),
  };
}

function energyDensityReview(chart: Chart, analysis: BeatAnalysis) {
  const windows = activeEnergyWindows(analysis).sort((left, right) => left.averageEnergy - right.averageEnergy);
  if (windows.length < 4) return null;
  const quartileSize = Math.max(1, Math.floor(windows.length / 4));
  const quieter = densityForWindows(chart, windows.slice(0, quartileSize));
  const energetic = densityForWindows(chart, windows.slice(-quartileSize));
  return {
    windowMs: 4_000,
    eligibleActiveWindows: windows.length,
    quartileWindows: quartileSize,
    quieter,
    energetic,
    eventDensityRatio: round(energetic.eventsPerMinute / Math.max(0.01, quieter.eventsPerMinute), 3),
    tapDensityRatio: round(energetic.tapNotesPerMinute / Math.max(0.01, quieter.tapNotesPerMinute), 3),
  };
}

function maximumBurst(chart: Chart, rate: PlaybackRate, wallWindowMs: number) {
  const sourceWindowMs = wallWindowMs * rate;
  const notes = [...chart.notes].sort((left, right) => left.timeMs - right.timeMs || left.lane - right.lane);
  let endIndex = 0;
  let maximumInputs = 0;
  let maximumEvents = 0;
  let maximumStartMs = 0;
  for (let startIndex = 0; startIndex < notes.length; startIndex += 1) {
    if (endIndex < startIndex) endIndex = startIndex;
    const startMs = notes[startIndex].timeMs;
    while (endIndex < notes.length && notes[endIndex].timeMs < startMs + sourceWindowMs) endIndex += 1;
    const inputs = endIndex - startIndex;
    const events = new Set(notes.slice(startIndex, endIndex).map((note) => note.timeMs)).size;
    if (inputs > maximumInputs || (inputs === maximumInputs && events > maximumEvents)) {
      maximumInputs = inputs;
      maximumEvents = events;
      maximumStartMs = startMs;
    }
  }
  return { wallWindowMs, sourceWindowMs, maximumInputs, maximumEvents, sourceStartMs: maximumStartMs };
}

function chartReview(chart: Chart, analysis: BeatAnalysis) {
  const eventTimes = [...new Set(chart.notes.map((note) => note.timeMs))].sort((left, right) => left - right);
  const gaps = eventTimes.slice(1).map((timeMs, index) => timeMs - eventTimes[index]);
  const kinds = Object.fromEntries(['tap', 'hold', 'flick', 'slide'].map((kind) => [
    kind,
    chart.notes.filter((note) => note.kind === kind).length,
  ])) as Record<Note['kind'], number>;
  const sustainEvents = new Set(chart.notes.filter((note) => note.kind === 'hold' || note.kind === 'slide')
    .map((note) => note.timeMs)).size;
  const eligibleOnsets = activeOnsets(analysis);
  const minutes = analysis.durationMs / 60_000;
  return {
    chartId: chart.id,
    notes: chart.notes.length,
    events: eventTimes.length,
    notesPerMinute: round(chart.notes.length / minutes),
    eventsPerMinute: round(eventTimes.length / minutes),
    eligibleOnsets,
    onsetSelectionPercent: round(100 * eventTimes.length / Math.max(1, eligibleOnsets)),
    kinds,
    sustainNotes: kinds.hold + kinds.slide,
    sustainNotePercent: round(100 * (kinds.hold + kinds.slide) / Math.max(1, chart.notes.length)),
    sustainEventPercent: round(100 * sustainEvents / Math.max(1, eventTimes.length)),
    chordEvents: eventTimes.filter((timeMs) => chart.notes.filter((note) => note.timeMs === timeMs).length > 1).length,
    minimumEventGapMs: gaps.length ? Math.min(...gaps) : null,
    minimumWallEventGapMsAt1_5x: gaps.length ? round(Math.min(...gaps) / 1.5) : null,
    medianEventGapMs: gaps.length ? [...gaps].sort((left, right) => left - right)[Math.floor(gaps.length / 2)] : null,
    energyDensity: energyDensityReview(chart, analysis),
    burstsAt1_5x: {
      wall500ms: maximumBurst(chart, 1.5, 500),
      wall1000ms: maximumBurst(chart, 1.5, 1_000),
    },
    validation: Object.fromEntries(RATES.map((rate) => [rate, validateChart(chart, rate)])),
    geometry: Object.fromEntries(RATES.map((rate) => [rate, stageWidths.map((width) => geometryReview(chart, rate, width))])),
  };
}

function nestingReview(lower: Chart, upper: Chart) {
  const lowerTimes = [...new Set(lower.notes.map((note) => note.timeMs))];
  const upperTimes = new Set(upper.notes.map((note) => note.timeMs));
  const sharedTimes = lowerTimes.filter((timeMs) => upperTimes.has(timeMs));
  const lanePreserved = sharedTimes.filter((timeMs) => {
    const lowerLanes = lower.notes.filter((note) => note.timeMs === timeMs).map((note) => note.lane);
    const upperLanes = new Set(upper.notes.filter((note) => note.timeMs === timeMs).map((note) => note.lane));
    return lowerLanes.every((lane) => upperLanes.has(lane));
  });
  return {
    lower: lower.difficulty,
    upper: upper.difficulty,
    lowerEvents: lowerTimes.length,
    sharedEvents: sharedTimes.length,
    eventNestingPercent: round(100 * sharedTimes.length / Math.max(1, lowerTimes.length)),
    laneMotifPreservationPercent: round(100 * lanePreserved.length / Math.max(1, lowerTimes.length)),
  };
}

function markdown(report: Awaited<ReturnType<typeof buildReport>>): string {
  const lines = [
    `# Generic chart geometry audit (${report.label})`,
    '',
    `- chart.ts SHA-256: \`${report.chartSource.sha256}\``,
    `- Generated: ${report.generatedAt}`,
    `- Analyses: ${report.totals.analyses}; charts: ${report.totals.charts}`,
    `- Exact raw-body collisions: ${report.totals.exactCollisionObservations}`,
    `- Conservative swept-lane reservation violations: ${report.totals.reservationViolationObservations}`,
    `- Existing validateChart errors: ${report.totals.validatorErrors}`,
    '',
    '| Song | Difficulty | Events/min | Onsets selected | Sustain notes | Quiet -> energetic EPM | Energy ratio | Max inputs / 1s @1.5x | Raw collisions | Reservation violations |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const song of report.songs) {
    for (const difficulty of DIFFICULTIES) {
      const chart = song.charts[difficulty];
      const canonical = chart.geometry['1'].find((entry) => entry.stageWidth === 400)!;
      const energy = chart.energyDensity;
      lines.push(`| ${song.file} | ${difficulty} | ${chart.eventsPerMinute} | ${chart.onsetSelectionPercent}% | ${chart.sustainNotePercent}% | ${energy ? `${energy.quieter.eventsPerMinute} -> ${energy.energetic.eventsPerMinute}` : 'n/a'} | ${energy?.eventDensityRatio ?? 'n/a'} | ${chart.burstsAt1_5x.wall1000ms.maximumInputs} | ${canonical.collisionCount} | ${canonical.reservationViolationCount} |`);
    }
  }
  lines.push('', '## Difficulty nesting', '', '| Song | Step | Event nesting | Lane motif preservation |', '| --- | --- | ---: | ---: |');
  for (const song of report.songs) {
    for (const nesting of song.nesting) {
      lines.push(`| ${song.file} | ${nesting.lower} -> ${nesting.upper} | ${nesting.eventNestingPercent}% | ${nesting.laneMotifPreservationPercent}% |`);
    }
  }
  lines.push(
    '',
    '## Conservative reservation proof',
    '',
    'A raw body occupies the source-time projection `[note.timeMs, note.timeMs + tileDurationMs]`. For a slide, reserve every integer lane between the minimum and maximum authored path lane for that complete interval. A candidate is safe only when its onset is at or after every reservation end in each lane it will occupy. Short stationary tiles may use the layout shrink rule against the next note with the same start lane; a slide destination must instead clear the full cross-rate short-body maximum (324 source ms), because the layout cache does not index target lanes.',
    '',
    'At stage widths of at least 224 px, each body is strictly narrower than one lane. Disjoint reserved lane sets therefore imply disjoint horizontal rectangles, while disjoint body intervals imply disjoint vertical rectangles. `streamingSustainGeometry` keeps an active body inside the raw body vertically and uses the same `laneAt` center, so raw-body disjointness also proves active-body disjointness. The exact collision pass independently evaluates piecewise-linear slide positions over the common visible interval.',
    '',
    'Counts are observations across the four playback rates and four audited stage widths where stated in JSON. A swept-lane reservation count of zero is the conservative proof target for all body widths below one lane.',
  );
  return `${lines.join('\n')}\n`;
}

async function buildReport() {
  const chartSource = await readFile(join(projectRoot, 'src', 'rhythm', 'chart.ts'), 'utf8');
  const chartFiles = (await readdir(join(projectRoot, 'public', 'charts'))).filter((file) => file.endsWith('.json')).sort();
  const songs = [];
  let exactCollisionObservations = 0;
  let reservationViolationObservations = 0;
  let validatorErrors = 0;
  for (const file of chartFiles) {
    const analysis = JSON.parse(await readFile(join(projectRoot, 'public', 'charts', file), 'utf8')) as BeatAnalysis;
    const generated = generateCharts(analysis);
    const charts = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, chartReview(generated[difficulty], analysis)])) as Record<Difficulty, ReturnType<typeof chartReview>>;
    for (const chart of Object.values(charts)) {
      validatorErrors += Object.values(chart.validation).reduce((sum, errors) => sum + errors.length, 0);
      for (const byWidth of Object.values(chart.geometry)) {
        exactCollisionObservations += byWidth.reduce((sum, geometry) => sum + geometry.collisionCount, 0);
        reservationViolationObservations += byWidth.reduce((sum, geometry) => sum + geometry.reservationViolationCount, 0);
      }
    }
    songs.push({
      file: basename(file, '.json'),
      durationMs: analysis.durationMs,
      bpm: analysis.bpm,
      onsets: analysis.onsets.length,
      sustains: analysis.sustains?.length ?? 0,
      charts,
      nesting: DIFFICULTIES.slice(0, -1).map((difficulty, index) => nestingReview(generated[difficulty], generated[DIFFICULTIES[index + 1]])),
    });
  }
  return {
    schemaVersion: 1,
    label,
    generatedAt: new Date().toISOString(),
    chartSource: { sha256: sha256(chartSource), bytes: Buffer.byteLength(chartSource) },
    geometryModel: {
      bodyInterval: '[note.timeMs, note.timeMs + tileDurationMs(chart,note,rate)]',
      activeBodyRelation: 'streamingSustainGeometry is a vertical subset of the raw body; raw disjointness proves active disjointness',
      slideReservation: 'every integer lane between the minimum and maximum authored path lane is reserved for the body interval',
      supportedStageWidthCondition: 'width >= 224 px, so max(48, laneWidth - 8) remains strictly narrower than one lane',
      rates: RATES,
      auditedStageWidths: stageWidths,
    },
    songs,
    totals: {
      analyses: songs.length,
      charts: songs.length * DIFFICULTIES.length,
      exactCollisionObservations,
      reservationViolationObservations,
      validatorErrors,
    },
  };
}

try {
  const report = await buildReport();
  const catalog = await vite.ssrLoadModule('/src/data/catalog.ts') as { BUNDLED_SONGS: unknown[] };
  const expectedAnalyses = catalog.BUNDLED_SONGS.length;
  if (report.totals.analyses !== expectedAnalyses || report.totals.charts !== expectedAnalyses * DIFFICULTIES.length) {
    throw new Error(`Expected ${expectedAnalyses} analyses and ${expectedAnalyses * DIFFICULTIES.length} charts; got ${report.totals.analyses} and ${report.totals.charts}.`);
  }
  await mkdir(join(projectRoot, 'output'), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, markdown(report), 'utf8');
  console.log(`Wrote ${jsonPath} and ${markdownPath}`);
} finally {
  await vite.close();
}
