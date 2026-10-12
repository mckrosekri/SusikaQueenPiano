import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Results } from './Results';
import type { RunResult } from '../types';
const result: RunResult = { id: 'run', songId: 'song', chartId: 'chart', difficulty: 'easy', rate: 1, score: 500000, accuracy: 50, maxCombo: 5, counts: { perfect: 5, great: 0, good: 0, miss: 5 }, early: 0, late: 0, practice: false, completed: true, createdAt: 0 };
const render = (overrides: Partial<RunResult> = {}) => renderToStaticMarkup(<Results result={{ ...result, ...overrides }} results={[{ ...result, ...overrides }]} personalBest={true} onRetry={() => {}} onChooseSong={() => {}} onNextDifficulty={() => {}} />);
it('offers the next stage after a one-star full clear and shows its ranked score', () => {
  const html = render();
  expect(html).toContain('1 of 3 stars'); expect(html).toContain('Next difficulty'); expect(html).toContain('Normal unlocked'); expect(html).toContain('This performance'); expect(html).toContain(result.score.toLocaleString());
});
it('does not offer stars, progression or personal bests for practice and incomplete performances', () => {
  for (const overrides of [{ practice: true }, { completed: false }]) {
    const html = render(overrides);
    expect(html).toContain('0 of 3 stars'); expect(html).not.toContain('Next difficulty'); expect(html).not.toContain('New personal best'); expect(html).not.toContain('This performance');
  }
});
it('ends progression at Expert and keeps replay and song menu', () => {
  const html = render({ difficulty: 'expert', accuracy: 90 });
  expect(html).toContain('3 of 3 stars'); expect(html).toContain('Expert, beautifully yours'); expect(html).not.toContain('Next difficulty'); expect(html).toContain('Play again'); expect(html).toContain('Song menu');
});
