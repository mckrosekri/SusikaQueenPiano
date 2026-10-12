import { CHART_VERSION } from '../rhythm/chart';
import { DIFFICULTIES, type BeatAnalysis, type Chart, type Difficulty, type Note, type Song } from '../types';

/** Development-only, original synthetic piano. Exercises the actual App without touching saved progress. */
function syntheticPiano(durationMs: number): string {
  const sampleRate = 16000, seconds = durationMs / 1000;
  const wav = new ArrayBuffer(44 + sampleRate * seconds * 2), view = new DataView(wav);
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, wav.byteLength - 44, true);
  for (let i = 0; i < sampleRate * seconds; i++) {
    const t = i / sampleRate, phase = t % 1;
    const value = Math.sin(2 * Math.PI * [261.63, 329.63, 392, 523.25][Math.floor(t) % 4] * t) * Math.exp(-phase * 6) * .16;
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
}

export function gameplayFixtures(): Song[] {
  const durationMs = 8000, audioUrl = syntheticPiano(durationMs);
  const analysis: BeatAnalysis = { version: 'afterbeat-analysis-v2', audioHash: 'synthetic-qa', durationMs, bpm: 60, beatsMs: [1000, 2000, 3000, 4000, 5000, 6000], onsets: [], energy: [], intensity: .5, confidence: 1, warnings: [] };
  const notes: Record<Difficulty, Note[]> = {
    easy: [{ id: 'tap-e', kind: 'tap', lane: 0, timeMs: 1000 }],
    normal: [{ id: 'tap-n1', kind: 'tap', lane: 0, timeMs: 1000 }, { id: 'tap-n2', kind: 'tap', lane: 3, timeMs: 2000 }],
    hard: [{ id: 'tap-h1', kind: 'tap', lane: 0, timeMs: 1000 }, { id: 'tap-h2', kind: 'tap', lane: 3, timeMs: 1000 }, { id: 'dog-h', kind: 'hold', lane: 1, timeMs: 3000, endTimeMs: 4300 }],
    expert: [{ id: 'slide-x', kind: 'slide', lane: 0, timeMs: 1000, endTimeMs: 4600, targetLane: 3, direction: 1, path: [{ timeMs: 1000, lane: 0 }, { timeMs: 1400, lane: 0 }, { timeMs: 2400, lane: 1 }, { timeMs: 3400, lane: 2 }, { timeMs: 4600, lane: 3 }] }, { id: 'tap-x', kind: 'tap', lane: 2, timeMs: 6000 }],
  };
  const charts = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, { id: `qa-${difficulty}`, version: CHART_VERSION, audioHash: analysis.audioHash, difficulty, notes: notes[difficulty], approachMs: 1400, rating: 1, durationMs } satisfies Chart]));
  const comboDuration = 25000;
  const comboNotes: Note[] = [
    ...Array.from({ length: 32 }, (_, index) => ({ id: `combo-${index}`, kind: 'tap' as const, lane: index % 4, timeMs: 1000 + index * 400 })),
    { id: 'combo-dog', kind: 'hold', lane: 1, timeMs: 15100, endTimeMs: 18100 },
    { id: 'combo-tap-with-dog', kind: 'tap', lane: 3, timeMs: 17800 },
    { id: 'combo-miss', kind: 'tap', lane: 0, timeMs: 19000 },
    ...Array.from({ length: 4 }, (_, index) => ({ id: `recovery-${index}`, kind: 'tap' as const, lane: index % 4, timeMs: 22000 + index * 400 })),
  ];
  const comboAnalysis = { ...analysis, audioHash: 'synthetic-qa-combo', durationMs: comboDuration };
  const comboCharts = Object.fromEntries(DIFFICULTIES.map(difficulty => [difficulty, { id: `qa-combo-${difficulty}`, version: CHART_VERSION, audioHash: comboAnalysis.audioHash, difficulty, notes: comboNotes, approachMs: 1400, rating: 1, durationMs: comboDuration } satisfies Chart]));
  const lineNotes: Note[] = [1000, 2000, 3000].map((timeMs, lane) => ({ id: `line-${lane}`, kind: 'tap', lane, timeMs }));
  const lineCharts = Object.fromEntries(DIFFICULTIES.map(difficulty => [difficulty, { id: `qa-line-${difficulty}`, version: CHART_VERSION, audioHash: analysis.audioHash, difficulty, notes: lineNotes, approachMs: 1400, rating: 1, durationMs } satisfies Chart]));
  const rapidNotes: Note[] = Array.from({ length: 18 }, (_, index) => ({ id: `rapid-${index}`, kind: 'tap', lane: index % 2,
    timeMs: 1000 + index * 180 }));
  const rapidCharts = Object.fromEntries(DIFFICULTIES.map(difficulty => [difficulty, { id: `qa-rapid-${difficulty}`, version: CHART_VERSION,
    audioHash: analysis.audioHash, difficulty, notes: rapidNotes, approachMs: 1050, rating: 9, durationMs } satisfies Chart]));
  return [
    { id: 'visual-test-piano', title: 'Little Piano Test', artist: 'Original synthetic piano', genre: 'Pop', source: 'demo', durationMs, bpm: 60, color: '#f8c8d9', audioUrl, featuredOrder: 1, analysis, charts },
    { id: 'visual-test-combo', title: 'Combo Fire Test', artist: 'Original synthetic piano', genre: 'Pop', source: 'demo', durationMs: comboDuration, bpm: 150, color: '#f8c8d9', audioUrl: syntheticPiano(comboDuration), featuredOrder: 2, analysis: comboAnalysis, charts: comboCharts },
    { id: 'visual-test-line', title: 'Rhythm Line Test', artist: 'Original synthetic piano', genre: 'Pop', source: 'demo', durationMs, bpm: 60, color: '#f8c8d9', audioUrl, featuredOrder: 3, analysis, charts: lineCharts },
    { id: 'visual-test-rapid', title: 'Rapid Tap Test', artist: 'Original synthetic piano', genre: 'Pop', source: 'demo', durationMs, bpm: 60, color: '#f8c8d9', audioUrl, featuredOrder: 4, analysis, charts: rapidCharts },
  ];
}
