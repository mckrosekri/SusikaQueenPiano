import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MasteryJourney } from './MasteryJourney';
import { Library } from './Library';
import { SongDetails } from './SongDetails';
import { SCORING_VERSION } from '../rhythm/judgement';
import { DEFAULT_SETTINGS, type Progress, type RunResult, type Song } from '../types';
const record: RunResult = { id: 'earned', songId: 'song', chartId: 'chart', difficulty: 'expert', rate: 1, score: 200000, accuracy: 90, maxCombo: 1, counts: { perfect: 1, great: 0, good: 0, miss: 0 }, early: 0, late: 0, practice: false, completed: true, createdAt: 1 };
const progress: Progress = { version: 1, results: [record], favorites: [], lastPlayed: {}, settings: DEFAULT_SETTINGS, tutorialComplete: true };
it('keeps legacy unlocked tiers consistent in the mastery journey', () => {
  const html = renderToStaticMarkup(<MasteryJourney progress={progress} onBack={() => {}} onPlay={() => {}} />);
  expect(html).not.toContain('is-locked'); expect(html).toContain('Ivory trail');
});
it('does not label an incomplete higher-scoring performance as the library best', () => {
  const song: Song = { id: 'song', title: 'Song', artist: 'Artist', genre: 'Pop', durationMs: 8000, bpm: 60, color: '', source: 'demo', featuredOrder: 1 };
  const html = renderToStaticMarkup(<Library songs={[{ ...song, id: 'hero', featuredOrder: 0 }, song]} progress={{ ...progress, results: [record, { ...record, id: 'incomplete', score: 990001, completed: false }] }} onChoose={() => {}} onQuickPlay={() => {}} onToggleFavorite={() => {}} onImport={() => {}} onCancelImport={() => {}} onDeleteImport={() => {}} />);
  expect(html).toContain(record.score.toLocaleString()); expect(html).not.toContain((990001).toLocaleString());
});
it('shows earned scores in Song Details using the engine scoring namespace', () => {
  const song: Song = { id: 'song', title: 'Song', artist: 'Artist', genre: 'Pop', durationMs: 8000, bpm: 60, color: '', source: 'demo' };
  const html = renderToStaticMarkup(<SongDetails song={song} charts={{easy:{id:'chart',version:'v6',audioHash:'hash',difficulty:'easy',notes:[],rating:1,approachMs:1400,durationMs:8000}}} results={[{...record,difficulty:'easy',accuracy:49,chartId:`${SCORING_VERSION}:chart`}]} favorite={false} onBack={() => {}} onToggleFavorite={() => {}} onStart={() => {}} onRepair={async () => {}} />);
  expect(html).toContain(record.score.toLocaleString()); expect(html).not.toContain('Your first full performance starts the board');
});
