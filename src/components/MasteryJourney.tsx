import { ArrowLeft, Check, Lock, Sparkles, Star } from 'lucide-react';
import type { Progress } from '../types';
import { isDifficultyUnlocked } from '../services/progression';

interface MasteryJourneyProps { progress: Progress; onBack: () => void; onPlay: () => void }

export function MasteryJourney({ progress, onBack, onPlay }: MasteryJourneyProps) {
  const ranked = progress.results.filter((result) => !result.practice && result.completed);
  const has = (difficulty: string, accuracy = 0) => ranked.some((result) => result.difficulty === difficulty && result.accuracy >= accuracy);
  const available = (difficulty: 'normal' | 'hard' | 'expert') => ranked.some(result => isDifficultyUnlocked(ranked, result.songId, difficulty));
  const steps = [
    { title: 'Easy · your first star', copy: 'Earn 50% on a full Easy song to unlock its Normal stage.', complete: has('easy', 50), available: true },
    { title: 'Normal · hold the sound', copy: 'Earn one star on Normal to unlock Hard for that song.', complete: has('normal', 50), available: available('normal') },
    { title: 'Hard · double the magic', copy: 'Earn one star on Hard to unlock Expert. Always at most two fingers.', complete: has('hard', 50), available: available('hard') },
    { title: 'Expert · your royal encore', copy: 'Clear Expert, then chase three stars at 90%. Each song has its own journey.', complete: has('expert', 50), available: available('expert') },
  ];
  const clears = steps.filter((step) => step.complete).length;
  const rewards = [
    { name: 'Ivory trail', requirement: 'Your first trail', unlocked: true },
    { name: 'Crimson wake', requirement: 'Earn 88% on Hard', unlocked: has('hard', 88) },
    { name: 'Silver overture', requirement: 'Earn 90% on Expert', unlocked: has('expert', 90) },
  ];
  return (
    <section className="journey-screen" aria-labelledby="journey-title">
      <header className="detail-bar"><button className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeft aria-hidden="true" /></button><span>Mastery</span><span /></header>
      <div className="page-heading"><p className="eyebrow">Your repertoire</p><h1 id="journey-title">Master the language of rhythm.</h1><p>{clears} of {steps.length} movements complete. Progress comes from your finished performances.</p></div>
      <div className="journey-line">
        {steps.map((step, index) => <article key={step.title} className={`journey-step${step.complete ? ' is-complete' : ''}${!step.available ? ' is-locked' : ''}`}>
          <div className="journey-step__marker">{step.complete ? <Check aria-hidden="true" /> : step.available ? <span>{index + 1}</span> : <Lock aria-hidden="true" />}</div>
          <div><span className="eyebrow">Movement {String(index + 1).padStart(2, '0')}</span><h2>{step.title}</h2><p>{step.copy}</p>{step.available && !step.complete && <button className="text-button" onClick={onPlay}>Play to progress</button>}</div>
        </article>)}
      </div>
      <div className="rewards-section"><div className="section-heading"><div><p className="eyebrow">Encore rewards</p><h2>Skins & effects</h2></div><Sparkles aria-hidden="true" /></div>
        <div className="reward-list">{rewards.map((reward) => <div key={reward.name} className={reward.unlocked ? 'is-unlocked' : ''}>{reward.unlocked ? <Star fill="currentColor" aria-hidden="true" /> : <Lock aria-hidden="true" />}<span><strong>{reward.name}</strong><small>{reward.unlocked ? 'Unlocked from your results' : reward.requirement}</small></span></div>)}</div>
      </div>
    </section>
  );
}
