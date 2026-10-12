export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';
export type PlaybackRate = 0.75 | 1 | 1.25 | 1.5;
export type NoteKind = 'tap' | 'hold' | 'flick' | 'slide';
export type Judgement = 'perfect' | 'great' | 'good' | 'miss';
export type NoteSkin = 'ivory' | 'crimson' | 'silver';
export interface Onset { timeMs: number; strength: number }
export interface SustainRegion { startMs: number; endMs: number; confidence: number }
export interface ActivityRegion { startMs: number; endMs: number }
export interface BeatAnalysis {
  version: string; audioHash: string; durationMs: number; bpm: number;
  beatsMs: number[]; onsets: Onset[]; energy: number[];
  confidence: number; warnings: string[]; intensity: number;
  /** Conservative stable tonal regions, not transcribed instrument notes. */
  sustains?: SustainRegion[];
  /** Audible signal regions; used to avoid placing notes through silence. */
  activity?: ActivityRegion[];
}
export interface Note {
  id: string; kind: NoteKind; lane: number; timeMs: number;
  endTimeMs?: number; targetLane?: number; direction?: -1 | 1;
  path?: Array<{ timeMs: number; lane: number }>;
}
export interface Chart {
  id: string; version: string; audioHash: string; difficulty: Difficulty;
  notes: Note[]; rating: number; approachMs: number; durationMs: number;
}
export interface Song {
  id: string; title: string; artist: string; genre: string; durationMs: number;
  bpm: number; color: string; source: 'bundled' | 'demo' | 'import'; audioUrl?: string;
  audioHash?: string; artworkUrl?: string; rank?: number; featuredOrder?: number;
  licenseUrl?: string; sourceUrl?: string; credit?: string;
  analysis?: BeatAnalysis; charts?: Partial<Record<Difficulty, Chart>>;
  favorite?: boolean; addedAt?: number;
}
export interface RunConfig {
  difficulty: Difficulty; rate: PlaybackRate; practice: boolean;
  startMs: number; endMs?: number; loop: boolean;
}
export interface RunResult {
  id: string; songId: string; chartId: string; difficulty: Difficulty;
  rate: PlaybackRate; score: number; accuracy: number; maxCombo: number;
  counts: Record<Judgement, number>; early: number; late: number;
  practice: boolean; createdAt: number; completed: boolean;
}
export interface Settings {
  calibrationMs: number; effects: 'full' | 'reduced' | 'minimal';
  haptics: boolean; musicVolume: number; feedbackVolume: number;
  skin: NoteSkin;
}
export interface Progress {
  version: 1; results: RunResult[]; favorites: string[];
  /** Compact ranked records survive the recent-run history limit. */
  rankedRecords?: RunResult[];
  lastPlayed: Record<string, number>; settings: Settings; tutorialComplete: boolean; gameplayVersion?: 'tiles-v2' | 'line-v3';
}
export const DEFAULT_SETTINGS: Settings = { calibrationMs: 0, effects: 'full', haptics: true, musicVolume: 0.85, feedbackVolume: 0.2, skin: 'ivory' };
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'expert'];
export const RATES: PlaybackRate[] = [0.75, 1, 1.25, 1.5];
