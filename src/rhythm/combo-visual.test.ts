import { describe, expect, it } from 'vitest';
import { comboVisualState } from './combo-visual';

describe('flawless combo intensity', () => {
  it('activates at 8, 16 and 32 completed gestures and increases monotonically', () => {
    expect(comboVisualState(7).heat).toBe(0);
    expect([8, 16, 32].map(count => comboVisualState(count).label)).toEqual(['SPARKLE', 'ON FIRE', 'QUEEN MODE']);
    const heat = Array.from({ length: 101 }, (_, count) => comboVisualState(count).heat);
    expect(heat.every((value, index) => value >= (heat[index - 1] ?? 0) && value <= 1)).toBe(true);
    expect(comboVisualState(100).heat).toBe(1);
  });
  it('returns fully cold on reset and safely handles invalid counters', () => {
    for (const count of [0, -1, NaN, Infinity]) expect(comboVisualState(count)).toEqual({ heat: 0, label: 'BUILD YOUR COMBO', tier: 0 });
  });
});
