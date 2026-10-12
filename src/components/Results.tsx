import { ArrowLeft, ArrowRight, Crown, RotateCcw, Target, Trophy } from 'lucide-react';
import type { RunResult } from '../types';
import { nextDifficulty, starsForResult } from '../services/progression';
import { Stars } from './Stars';
import { Leaderboard } from './Leaderboard';
interface ResultsProps {
  result: RunResult; results: RunResult[]; songTitle?: string; personalBest: boolean;
  onRetry: () => void; onChooseSong: () => void; onNextDifficulty: () => void;
}
export function Results({ result, results, songTitle, personalBest, onRetry, onChooseSong, onNextDifficulty }: ResultsProps) {
  const cleared = result.counts.perfect + result.counts.great + result.counts.good;
  const stars = starsForResult(result);
  const next = nextDifficulty(result.difficulty);
  const passed = stars > 0;
  return <section className="results-screen" aria-labelledby="result-title">
    <p className="eyebrow">{result.practice ? 'Practice complete' : result.completed ? 'Performance complete' : 'Performance ended'} · {result.difficulty} · {result.rate}×</p>
    <Stars count={stars} large />
    <h1 id="result-title">{result.practice ? 'A little more magic.' : passed ? next ? 'You’re a star, Susika.' : 'Expert, beautifully yours.' : 'Your encore awaits.'}</h1>
    {songTitle && <p className="result-song">{songTitle}</p>}
    <p className="result-unlock" role="status">{result.practice ? 'Practice earns points, but no stars or unlocks.' : !result.completed ? 'Finish the full song to earn stars.' : passed ? next ? `${next[0].toUpperCase() + next.slice(1)} unlocked. Ready for your next stage?` : 'Expert cleared. Chase your three-star encore.' : next ? 'Earn 50% for one star and unlock the next difficulty.' : 'Earn 50% for one star and clear Expert.'}</p>
    <p className="star-thresholds">★ 50% &nbsp; ★★ 75% &nbsp; ★★★ 90%</p>
    {personalBest && !result.practice && result.completed && <div className="pb-ribbon"><Crown aria-hidden="true" /> New personal best</div>}
    <div className="score-lockup"><span>Score</span><strong>{result.score.toLocaleString()}</strong></div>
    <div className="result-highlights">
      <div><Target aria-hidden="true" /><span>Points earned</span><strong>{result.accuracy.toFixed(1)}%</strong></div>
      <div><Trophy aria-hidden="true" /><span>Best streak</span><strong>{result.maxCombo}</strong></div>
    </div>
    <div className="judgement-table" aria-label="Tile counts">
      <div><span className="judgement-dot judgement-dot--perfect" /><span>Cleared</span><strong>{cleared}</strong></div>
      <div><span className="judgement-dot judgement-dot--miss" /><span>Missed</span><strong>{result.counts.miss}</strong></div>
    </div>
    <div className="result-actions">
      {passed && next && <button className="primary-button result-next" onClick={onNextDifficulty}>Next difficulty <span>{next}</span><ArrowRight aria-hidden="true" /></button>}
      <button className={passed && next ? 'secondary-button' : 'primary-button'} onClick={onRetry}><RotateCcw aria-hidden="true" /> {result.practice ? 'Practice again' : passed ? 'Play again' : 'Try again'}</button>
      <button className="secondary-button" onClick={onChooseSong}><ArrowLeft aria-hidden="true" /> Song menu</button>
    </div>
    <Leaderboard results={results} songId={result.songId} difficulty={result.difficulty} rate={result.rate} chartId={result.chartId} currentRunId={result.id} />
    <p className="result-hold-tip">Early taps: {result.early} · Late taps: {result.late}. Center tiles on the glowing line for maximum points. Hold every dog or slide to its tail for full credit.</p>
  </section>;
}
