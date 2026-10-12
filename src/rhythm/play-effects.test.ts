import { describe, expect, it, vi } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { makeFlameContext, PlayEffects, playEffectMotionStep } from './play-effects';

interface MotionState {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

function advance(state: MotionState, deltaSeconds: number): MotionState {
  const step = playEffectMotionStep(deltaSeconds);
  return {
    x: state.x + state.velocityX * step.positionFactor,
    y: state.y + state.velocityY * step.positionFactor + step.gravityPosition,
    velocityX: state.velocityX * step.velocityFactor,
    velocityY: state.velocityY * step.velocityFactor + step.gravityVelocity,
  };
}

function simulate(frameSeconds: number): MotionState {
  let state: MotionState = { x: 0, y: 0, velocityX: 90, velocityY: -150 };
  for (let elapsed = 0; elapsed < 0.5 - 1e-9; elapsed += frameSeconds) state = advance(state, frameSeconds);
  return state;
}

describe('PlayEffects', () => {
  it('builds a tile-anchored flame that rises from its base within compact bounds', () => {
    const context = makeFlameContext();
    const graphic = new Graphics({ context });
    const bounds = graphic.getLocalBounds();

    expect(bounds.left).toBeGreaterThanOrEqual(-12);
    expect(bounds.right).toBeLessThanOrEqual(12);
    expect(bounds.top).toBeCloseTo(-42, 5);
    expect(bounds.bottom).toBeCloseTo(0, 5);
    expect(bounds.height).toBeGreaterThan(40);

    graphic.destroy();
    context.destroy();
  });

  it('keeps damped particle trajectories invariant across ordinary render cadences', () => {
    const sixtyFps = simulate(1 / 60);
    const thirtyFps = simulate(1 / 30);
    expect(thirtyFps.x).toBeCloseTo(sixtyFps.x, 8);
    expect(thirtyFps.y).toBeCloseTo(sixtyFps.y, 8);
    expect(thirtyFps.velocityX).toBeCloseTo(sixtyFps.velocityX, 8);
    expect(thirtyFps.velocityY).toBeCloseTo(sixtyFps.velocityY, 8);
  });

  it('caps display objects, drops overflow safely, and restores the complete pool on reset', () => {
    const layer = new Container();
    const effects = new PlayEffects(layer, 'full', false);
    for (let index = 0; index < 30; index += 1) effects.hit(100, 200, 0xffbad9, 'flick', true);
    const saturated = effects.metrics();
    expect(saturated.liveParticles).toBe(96);
    expect(saturated.liveRings).toBe(16);
    expect(saturated.livePulses).toBe(16);
    expect(saturated.droppedParticles).toBeGreaterThan(0);

    effects.reset();
    expect(effects.metrics()).toMatchObject({
      liveParticles: 0,
      pooledParticles: 96,
      liveFlames: 0,
      pooledFlames: 40,
      liveRings: 0,
      pooledRings: 16,
      livePulses: 0,
      pooledPulses: 16,
      emittedStars: 0,
      emittedParticles: 0,
      emittedFlames: 0,
      droppedParticles: 0,
      droppedFlames: 0,
    });
    effects.destroy();
    expect(layer.children).toHaveLength(0);
  });

  it('uses pulse-only feedback for reduced effects and OS reduced motion', () => {
    const reduced = new PlayEffects(new Container(), 'reduced', false);
    reduced.hit(20, 30, 0xe4c9ff, 'tap');
    expect(reduced.metrics()).toMatchObject({ livePulses: 1, liveRings: 0, liveParticles: 0 });

    const minimal = new PlayEffects(new Container(), 'minimal', false);
    minimal.hit(20, 30, 0xe4c9ff, 'tap');
    minimal.flameBurst(20, 30, 1);
    minimal.flameStream(20, 30, 1 / 30, 1);
    expect(minimal.metrics()).toMatchObject({ livePulses: 1, liveFlames: 0, emittedFlames: 0 });

    const motionReduced = new PlayEffects(new Container(), 'full', true);
    motionReduced.hit(20, 30, 0xe4c9ff, 'hold', true);
    motionReduced.stream(20, 30, 1 / 30, 0xe4c9ff);
    motionReduced.flameBurst(20, 30, 1);
    motionReduced.flameStream(20, 30, 1 / 30, 1);
    reduced.flameBurst(20, 30, 1);
    reduced.flameStream(20, 30, 1 / 30, 1);
    expect(reduced.metrics()).toMatchObject({ livePulses: 1, liveFlames: 0, emittedFlames: 0 });
    expect(motionReduced.metrics()).toMatchObject({ livePulses: 1, liveRings: 0, liveParticles: 0, liveFlames: 0, emittedFlames: 0, reducedMotion: true });
    reduced.destroy();
    minimal.destroy();
    motionReduced.destroy();
  });

  it('emits sustain stars at the same bounded rate at 30 and 60 fps', () => {
    const run = (deltaSeconds: number, frames: number) => {
      const effects = new PlayEffects(new Container(), 'full', false);
      for (let frame = 0; frame < frames; frame += 1) {
        effects.stream(80, 120, deltaSeconds, 0xffbad9);
        effects.update(deltaSeconds);
      }
      const metrics = effects.metrics();
      effects.destroy();
      return metrics;
    };
    const thirtyFps = run(1 / 30, 30);
    const sixtyFps = run(1 / 60, 60);
    expect(thirtyFps.emittedStars).toBe(30);
    expect(sixtyFps.emittedStars).toBe(30);
    expect(thirtyFps.liveParticles).toBeLessThanOrEqual(96);
    expect(sixtyFps.liveParticles).toBeLessThanOrEqual(96);
  });

  it('keeps simultaneous sustain streams fair and local to both fingers', () => {
    const layer = new Container();
    const effects = new PlayEffects(layer, 'full', false);
    for (let frame = 0; frame < 60; frame += 1) {
      effects.stream(40, 120, 1 / 60, 0xffbad9, 'left-hold');
      effects.stream(160, 120, 1 / 60, 0xe4c9ff, 'right-hold');
    }

    const visible = layer.children.filter((child) => child.visible);
    expect(effects.metrics().emittedStars).toBe(60);
    expect(visible.filter((child) => child.x < 100)).toHaveLength(30);
    expect(visible.filter((child) => child.x > 100)).toHaveLength(30);
    effects.destroy();
  });

  it('drops a disconnected source carry before the same note is re-grabbed', () => {
    const effects = new PlayEffects(new Container(), 'full', false);
    effects.stream(40, 120, 1 / 60, 0xffbad9, 'held-note');
    effects.update(1 / 60);
    effects.update(1 / 60);
    effects.stream(40, 120, 1 / 60, 0xffbad9, 'held-note');
    expect(effects.metrics().emittedStars).toBe(0);
    effects.destroy();
  });

  it('caps flames in their own pool and expires their short animation', () => {
    const layer = new Container();
    const effects = new PlayEffects(layer, 'full', false);
    for (let index = 0; index < 12; index += 1) effects.flameBurst(80, 120, 1);
    expect(effects.metrics()).toMatchObject({ liveFlames: 40, pooledFlames: 0, emittedFlames: 40 });
    expect(effects.metrics().droppedFlames).toBeGreaterThan(0);
    const liveFlameContexts = new Set(
      layer.children
        .filter((child) => child.visible)
        .map((child) => (child as Graphics).context),
    );
    expect(liveFlameContexts.size).toBe(1);

    for (let frame = 0; frame < 5; frame += 1) effects.update(0.12);
    expect(effects.metrics()).toMatchObject({ liveFlames: 0, pooledFlames: 40 });
    effects.destroy();
  });

  it('fans contact flames across the hit point and carries them outward', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const layer = new Container();
    const effects = new PlayEffects(layer, 'full', false);
    try {
      effects.flameBurst(80, 120, 1);
      const flames = layer.children.filter((child) => child.visible);
      const startingX = flames.map((flame) => flame.x);
      expect(flames).toHaveLength(6);
      expect(Math.min(...startingX)).toBeLessThan(74);
      expect(Math.max(...startingX)).toBeGreaterThan(86);

      effects.update(0.05);
      expect(flames[0].x).toBeLessThan(startingX[0]);
      expect(flames.at(-1)!.x).toBeGreaterThan(startingX.at(-1)!);
      expect(flames.every((flame) => flame.y < 120)).toBe(true);
    } finally {
      effects.destroy();
      random.mockRestore();
    }
  });

  it('clears fire and stream carry immediately without touching ordinary hit effects', () => {
    const effects = new PlayEffects(new Container(), 'full', false);
    effects.hit(80, 120, 0xffbad9, 'tap');
    effects.flameBurst(80, 120, 1);
    effects.flameStream(80, 120, 1 / 60, 1, 'held-head');
    const before = effects.metrics();
    expect(before.liveFlames).toBeGreaterThan(0);

    effects.clearFlames();
    expect(effects.metrics()).toMatchObject({
      liveFlames: 0,
      liveParticles: before.liveParticles,
      liveRings: before.liveRings,
      livePulses: before.livePulses,
    });
    effects.flameStream(80, 120, 1 / 60, 1, 'held-head');
    expect(effects.metrics().liveFlames).toBe(0);
    effects.destroy();
  });

  it('clamps flame intensity and keeps burst size bounded', () => {
    const effects = new PlayEffects(new Container(), 'full', false);
    effects.flameBurst(80, 120, -1);
    effects.flameBurst(80, 120, Number.NaN);
    expect(effects.metrics().emittedFlames).toBe(0);

    effects.flameBurst(80, 120, 5);
    expect(effects.metrics()).toMatchObject({ liveFlames: 6, emittedFlames: 6 });
    effects.clearFlames();
    effects.flameBurst(80, 120, Number.POSITIVE_INFINITY);
    expect(effects.metrics()).toMatchObject({ liveFlames: 6, emittedFlames: 12 });
    effects.destroy();
  });

  it('emits flame streams at the same bounded rate at 30 and 60 fps', () => {
    const run = (deltaSeconds: number, frames: number) => {
      const effects = new PlayEffects(new Container(), 'full', false);
      for (let frame = 0; frame < frames; frame += 1) {
        effects.flameStream(80, 120, deltaSeconds, 1, 'hold');
        effects.update(deltaSeconds);
      }
      const metrics = effects.metrics();
      effects.destroy();
      return metrics;
    };
    const thirtyFps = run(1 / 30, 30);
    const sixtyFps = run(1 / 60, 60);
    expect(thirtyFps.emittedFlames).toBe(24);
    expect(sixtyFps.emittedFlames).toBe(24);
    expect(thirtyFps.liveFlames).toBeLessThanOrEqual(40);
    expect(sixtyFps.liveFlames).toBeLessThanOrEqual(40);
  });

  it('reserves equal flame capacity for two simultaneous held sources', () => {
    const layer = new Container();
    const effects = new PlayEffects(layer, 'full', false);
    for (let frame = 0; frame < 60; frame += 1) {
      effects.flameStream(40, 120, 1 / 60, 1, 'left-hold');
      effects.flameStream(160, 120, 1 / 60, 1, 'right-hold');
    }

    const visible = layer.children.filter((child) => child.visible);
    expect(effects.metrics()).toMatchObject({ liveFlames: 40, emittedFlames: 40 });
    expect(visible.filter((child) => child.x < 100)).toHaveLength(20);
    expect(visible.filter((child) => child.x > 100)).toHaveLength(20);
    effects.destroy();
  });

  it('drops inactive flame-stream carry before a source reconnects', () => {
    const effects = new PlayEffects(new Container(), 'full', false);
    effects.flameStream(40, 120, 1 / 60, 1, 'held-head');
    effects.update(1 / 60);
    effects.update(1 / 60);
    effects.flameStream(40, 120, 1 / 60, 1, 'held-head');
    expect(effects.metrics().emittedFlames).toBe(0);
    effects.destroy();
  });
});
