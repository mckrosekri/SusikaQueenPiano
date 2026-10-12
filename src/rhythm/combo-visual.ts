/** A flawless streak rewards completed gestures, never just starting a hold. */
export function comboVisualState(streak: number): { heat: number; label: string; tier: number } {
  const count = Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0;
  const tier = count >= 32 ? 3 : count >= 16 ? 2 : count >= 8 ? 1 : 0;
  return {
    heat: tier ? Math.min(1, (count - 4) / 28) : 0,
    label: tier === 3 ? 'QUEEN MODE' : tier === 2 ? 'ON FIRE' : tier === 1 ? 'SPARKLE' : 'BUILD YOUR COMBO',
    tier,
  };
}
