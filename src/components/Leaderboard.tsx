import { Trophy } from 'lucide-react';
import type { Difficulty, PlaybackRate, RunResult } from '../types';
import { leaderboardFor, starsForResult } from '../services/progression';
import { Stars } from './Stars';
interface LeaderboardProps {
  results: RunResult[]; songId: string; difficulty: Difficulty; rate: PlaybackRate; chartId?: string; currentRunId?: string;
}
export function Leaderboard({ results, songId, difficulty, rate, chartId, currentRunId }: LeaderboardProps) {
  const rows = leaderboardFor(results, songId, difficulty, rate, chartId);
  return <section className="scoreboard" aria-label="Song leaderboard">
    <div className="section-heading"><div><p className="eyebrow">On this device · {difficulty} · {rate}×</p><h2>Your leaderboard</h2></div><Trophy aria-hidden="true" /></div>
    {rows.length ? <ol className="scoreboard-list">{rows.map((run, index) => <li key={run.id} className={run.id === currentRunId ? 'is-current' : ''}>
      <span className="scoreboard-rank">{String(index + 1).padStart(2, '0')}</span>
      <span className="scoreboard-run"><strong>{run.id === currentRunId ? 'This performance' : 'Your performance'}</strong><small>{new Date(run.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {run.accuracy.toFixed(1)}% · {run.maxCombo} streak</small></span>
      <span className="scoreboard-points"><strong>{run.score.toLocaleString()}</strong><Stars count={starsForResult(run)} /></span>
    </li>)}</ol> : <p className="scoreboard-empty">Your first full performance starts the board. Practice stays unranked.</p>}
    <p className="scoreboard-note">Top five performances. Each song, difficulty and speed has its own board.</p>
  </section>;
}
