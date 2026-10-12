export interface TileHitBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

export const POINTER_PADDING = 6;
export const MAX_RENDER_HIT_AGE_MS = 64;

export function isTileHitEligible<T extends { status: 'pending' | 'active' | 'done'; pointer?: number }>(
  state: T,
): state is T & { status: 'pending' | 'active' } {
  return state.status === 'pending' || state.status === 'active' && state.pointer === undefined;
}

/** Match the last painted tile before falling back to its event-time position. */
export function pickTileHitTarget<T extends TileHitBounds>(
  x: number, y: number, live: readonly T[], painted: readonly T[], paintAgeMs: number,
): (T & { exact: boolean }) | undefined {
  const matches: { target: T; exact: boolean; priority: number; distance: number }[] = [];
  const collect = (targets: readonly T[], paintedPosition: boolean) => {
    for (const target of targets) {
      const exact = x >= target.left && x <= target.right && y >= target.top && y <= target.bottom;
      if (!exact && !(x >= target.left - POINTER_PADDING && x <= target.right + POINTER_PADDING
        && y >= target.top - POINTER_PADDING && y <= target.bottom + POINTER_PADDING)) continue;
      matches.push({ target, exact, priority: exact ? paintedPosition ? 0 : 1 : paintedPosition ? 2 : 3,
        distance: Math.hypot(x - target.centerX, y - target.centerY) });
    }
  };
  if (Math.abs(paintAgeMs) <= MAX_RENDER_HIT_AGE_MS) collect(painted, true);
  collect(live, false);
  matches.sort((first, second) => first.priority - second.priority || first.distance - second.distance);
  const hit = matches[0];
  return hit ? { ...hit.target, exact: hit.exact } : undefined;
}
