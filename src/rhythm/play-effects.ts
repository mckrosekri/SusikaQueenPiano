import { Container, Graphics, GraphicsContext } from 'pixi.js';
import type { Settings } from '../types';

export type PlayEffectKind = 'tap' | 'hold' | 'slide' | 'flick';
export type PlayEffectIntensity = Settings['effects'];

export interface PlayEffectMetrics {
  liveParticles: number;
  pooledParticles: number;
  liveFlames: number;
  pooledFlames: number;
  liveRings: number;
  pooledRings: number;
  livePulses: number;
  pooledPulses: number;
  emittedStars: number;
  emittedParticles: number;
  emittedFlames: number;
  droppedParticles: number;
  droppedFlames: number;
  reducedMotion: boolean;
}

export interface PlayEffectMotionStep {
  velocityFactor: number;
  positionFactor: number;
  gravityVelocity: number;
  gravityPosition: number;
}

const PARTICLE_CAP = 96;
const FLAME_CAP = 40;
const FLAME_SOURCE_CAP = FLAME_CAP / 2;
const RING_CAP = 16;
const PULSE_CAP = 16;
const STREAM_RATE = 30;
const FLAME_STREAM_RATE = 24;
const DRAG = 5.2;
const GRAVITY = 155;

const STREAM_COLORS = [0xfff5ca, 0xffffff, 0xffbad9, 0xe4c9ff] as const;

type ParticleShape = 'heart' | 'star' | 'diamond';

interface ParticleSlot {
  graphic: Graphics;
  active: boolean;
  age: number;
  lifetime: number;
  velocityX: number;
  velocityY: number;
  spin: number;
}

interface RingSlot {
  graphic: Graphics;
  active: boolean;
  age: number;
  lifetime: number;
}

interface PulseSlot {
  graphic: Graphics;
  active: boolean;
  age: number;
  lifetime: number;
  staticTransform: boolean;
  peakAlpha: number;
  baseScale: number;
}

interface FlameSlot {
  graphic: Graphics;
  active: boolean;
  age: number;
  lifetime: number;
  velocityX: number;
  velocityY: number;
  spin: number;
  baseScale: number;
  sourceKey: string | null;
}

interface StreamState {
  carry: number;
  touched: boolean;
}

function finiteDelta(deltaSeconds: number): number {
  return Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(0.12, deltaSeconds)) : 0;
}

function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function easeOutCubic(value: number): number {
  const inverse = 1 - Math.max(0, Math.min(1, value));
  return 1 - inverse * inverse * inverse;
}

function unitIntensity(intensity: number): number {
  return Number.isNaN(intensity) ? 0 : Math.max(0, Math.min(1, intensity));
}

/** Analytic damped-motion terms, exported so cadence invariance can be tested without a renderer. */
export function playEffectMotionStep(
  deltaSeconds: number,
  drag = DRAG,
  gravity = GRAVITY,
): PlayEffectMotionStep {
  const delta = finiteDelta(deltaSeconds);
  const safeDrag = Number.isFinite(drag) ? Math.max(0, drag) : DRAG;
  const safeGravity = Number.isFinite(gravity) ? gravity : GRAVITY;
  if (safeDrag === 0) {
    return {
      velocityFactor: 1,
      positionFactor: delta,
      gravityVelocity: safeGravity * delta,
      gravityPosition: safeGravity * delta * delta * 0.5,
    };
  }
  const velocityFactor = Math.exp(-safeDrag * delta);
  const positionFactor = (1 - velocityFactor) / safeDrag;
  return {
    velocityFactor,
    positionFactor,
    gravityVelocity: safeGravity * positionFactor,
    gravityPosition: (safeGravity / safeDrag) * (delta - positionFactor),
  };
}

function makePulseContext(): GraphicsContext {
  return new GraphicsContext()
    .circle(0, 0, 15).fill({ color: 0xffffff, alpha: 0.08 })
    .circle(0, 0, 9).fill({ color: 0xffffff, alpha: 0.18 })
    .circle(0, 0, 4).fill({ color: 0xffffff, alpha: 0.42 });
}

function makeRingContext(): GraphicsContext {
  return new GraphicsContext()
    .circle(0, 0, 19).stroke({ color: 0xffffff, width: 2.4, alpha: 0.9 })
    .circle(0, 0, 14).stroke({ color: 0xffffff, width: 1, alpha: 0.28 });
}

function makeHeartContext(): GraphicsContext {
  return new GraphicsContext()
    .circle(-2.6, -1.8, 2.9).fill(0xffffff)
    .circle(2.6, -1.8, 2.9).fill(0xffffff)
    .moveTo(-5.4, 0)
    .lineTo(0, 6.4)
    .lineTo(5.4, 0)
    .closePath()
    .fill(0xffffff);
}

function makeStarContext(): GraphicsContext {
  const context = new GraphicsContext();
  const outerRadius = 6;
  for (let point = 0; point < 10; point += 1) {
    const angle = -Math.PI / 2 + point * Math.PI / 5;
    const radius = point % 2 ? outerRadius * 0.43 : outerRadius;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (point === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  return context.closePath().fill(0xffffff);
}

function makeDiamondContext(): GraphicsContext {
  return new GraphicsContext()
    .moveTo(0, -5.7)
    .lineTo(4.5, 0)
    .lineTo(0, 5.7)
    .lineTo(-4.5, 0)
    .closePath()
    .fill(0xffffff);
}

export function makeFlameContext(): GraphicsContext {
  return new GraphicsContext()
    // A translucent silhouette supplies a soft glow without a blur filter.
    // Every layer closes at y=0 so callers can pin the flame to a tile edge.
    .moveTo(-0.8, 0)
    .bezierCurveTo(-7.9, -0.2, -11.8, -4.8, -10.6, -12)
    .bezierCurveTo(-9.7, -18.3, -4.3, -22.2, -5.8, -29.2)
    .bezierCurveTo(-6.8, -34.1, -3.2, -38.7, 1.4, -42)
    .bezierCurveTo(0.7, -35.9, 6.8, -33.4, 5.5, -26.2)
    .bezierCurveTo(10.1, -22.9, 12, -17.3, 10.5, -11.1)
    .bezierCurveTo(9, -4.4, 4.8, -0.1, -0.8, 0)
    .closePath()
    .fill({ color: 0xff4f9b, alpha: 0.2 })
    .moveTo(-0.7, 0)
    .bezierCurveTo(-6.5, -0.1, -9.6, -4.4, -8.8, -11.7)
    .bezierCurveTo(-8, -18.2, -2.1, -22.5, -4, -29.6)
    .bezierCurveTo(-5, -34.1, -1.9, -38.1, 2.8, -40.4)
    .bezierCurveTo(1.1, -34.4, 7.5, -31.7, 5.1, -24.5)
    .bezierCurveTo(9.6, -20.9, 10.5, -14.3, 8.6, -8.6)
    .bezierCurveTo(6.9, -2.6, 3.2, -0.1, -0.7, 0)
    .closePath()
    .fill({ color: 0xff5a9f, alpha: 0.94 })
    .moveTo(-0.5, 0)
    .bezierCurveTo(-4.8, -0.1, -6.9, -4.6, -5.8, -10.6)
    .bezierCurveTo(-4.8, -15.2, -0.2, -17.5, -1.5, -23)
    .bezierCurveTo(-2.2, -26.8, 0.3, -30, 3.5, -32.3)
    .bezierCurveTo(2.3, -26.8, 6.7, -23.4, 5.3, -18)
    .bezierCurveTo(8, -14, 7.3, -8.2, 5.5, -4.1)
    .bezierCurveTo(3.9, -1.2, 1.5, 0, -0.5, 0)
    .closePath()
    .fill({ color: 0xffb47f, alpha: 0.98 })
    .moveTo(0.2, 0)
    .bezierCurveTo(-2.6, -0.1, -3.8, -2.6, -3.2, -5.6)
    .bezierCurveTo(-2.5, -8.8, 0.4, -10.8, 0.1, -14.7)
    .bezierCurveTo(-0.2, -17, 1.2, -19.3, 3.1, -20.8)
    .bezierCurveTo(2.1, -16.8, 4.8, -14.3, 4.1, -10.5)
    .bezierCurveTo(5.2, -7.1, 4.3, -2.1, 0.2, 0)
    .closePath()
    .fill({ color: 0xffffd5, alpha: 0.98 })
    .moveTo(0.4, 0)
    .bezierCurveTo(-1.2, -0.1, -1.9, -1.9, -1.5, -3.7)
    .bezierCurveTo(-1.2, -5.5, 0.3, -6.9, 0.8, -9.3)
    .bezierCurveTo(2.8, -6.8, 3.2, -4.3, 2.5, -2.3)
    .bezierCurveTo(2.1, -0.9, 1.3, 0, 0.4, 0)
    .closePath()
    .fill({ color: 0xfffff1, alpha: 0.86 });
}

function safeColor(color: number): number {
  if (!Number.isFinite(color)) return 0xffffff;
  return Math.max(0, Math.min(0xffffff, Math.trunc(color)));
}

function resetGraphic(graphic: Graphics, x: number, y: number, color: number): void {
  graphic.position.set(x, y);
  graphic.scale.set(1);
  graphic.rotation = 0;
  graphic.alpha = 1;
  graphic.tint = safeColor(color);
  graphic.visible = true;
}

export class PlayEffects {
  private readonly contexts = {
    pulse: makePulseContext(),
    ring: makeRingContext(),
    heart: makeHeartContext(),
    star: makeStarContext(),
    diamond: makeDiamondContext(),
    flame: makeFlameContext(),
  };

  private readonly particles: ParticleSlot[];
  private readonly flames: FlameSlot[];
  private readonly rings: RingSlot[];
  private readonly pulses: PulseSlot[];
  private readonly streams = new Map<string, StreamState>();
  private readonly flameStreams = new Map<string, StreamState>();
  private streamColorIndex = 0;
  private emittedStars = 0;
  private emittedParticles = 0;
  private emittedFlames = 0;
  private droppedParticles = 0;
  private droppedFlames = 0;
  private destroyed = false;

  constructor(
    private readonly layer: Container,
    private readonly intensity: PlayEffectIntensity,
    private readonly reducedMotion: boolean,
  ) {
    this.pulses = Array.from({ length: PULSE_CAP }, () => ({
      graphic: this.prepareGraphic(new Graphics({ context: this.contexts.pulse })),
      active: false,
      age: 0,
      lifetime: 0,
      staticTransform: false,
      peakAlpha: 0,
      baseScale: 1,
    }));
    this.rings = Array.from({ length: RING_CAP }, () => ({
      graphic: this.prepareGraphic(new Graphics({ context: this.contexts.ring })),
      active: false,
      age: 0,
      lifetime: 0,
    }));
    this.particles = Array.from({ length: PARTICLE_CAP }, () => ({
      graphic: this.prepareGraphic(new Graphics({ context: this.contexts.star })),
      active: false,
      age: 0,
      lifetime: 0,
      velocityX: 0,
      velocityY: 0,
      spin: 0,
    }));
    this.flames = Array.from({ length: FLAME_CAP }, () => ({
      graphic: this.prepareGraphic(new Graphics({ context: this.contexts.flame })),
      active: false,
      age: 0,
      lifetime: 0,
      velocityX: 0,
      velocityY: 0,
      spin: 0,
      baseScale: 1,
      sourceKey: null,
    }));
  }

  hit(
    x: number,
    y: number,
    color: number,
    kind: PlayEffectKind,
    completion = false,
  ): void {
    if (this.destroyed || !Number.isFinite(x) || !Number.isFinite(y)) return;

    const minimal = this.intensity === 'minimal';
    this.spawnPulse(x, y, color, minimal ? 0.15 : this.intensity === 'reduced' ? 0.25 : 0.58, minimal ? 0.6 : 1);
    if (minimal || this.intensity === 'reduced' || this.reducedMotion) return;

    this.spawnRing(x, y, color, completion ? 0.4 : 0.34);
    const count = completion ? 9 : kind === 'flick' ? 7 : 5;
    const speed = completion ? 112 : kind === 'flick' ? 104 : 86;
    const shape: ParticleShape = kind === 'hold' ? 'heart' : kind === 'slide' ? 'diamond' : kind === 'flick' ? 'star' : 'heart';
    const angleOffset = kind === 'flick' ? -Math.PI * 0.84 : -Math.PI;
    const angleSpan = kind === 'flick' ? Math.PI * 0.68 : Math.PI;

    for (let index = 0; index < count; index += 1) {
      const fraction = index / (count - 1);
      const angle = angleOffset + angleSpan * fraction + (Math.random() - 0.5) * 0.12;
      const particleSpeed = speed * (0.72 + Math.random() * 0.34);
      const selectedShape: ParticleShape = completion && index % 3 === 2 ? 'star' : index % 4 === 3 ? 'diamond' : shape;
      this.spawnParticle(
        x + (Math.random() - 0.5) * 4,
        y + (Math.random() - 0.5) * 3,
        color,
        selectedShape,
        Math.cos(angle) * particleSpeed,
        Math.sin(angle) * particleSpeed - (completion ? 24 : 12),
        0.34 + Math.random() * (completion ? 0.14 : 0.08),
        selectedShape === 'heart' ? 0 : (Math.random() - 0.5) * 5.2,
      );
    }
  }

  stream(x: number, y: number, deltaSeconds: number, color: number, sourceKey = 'default'): void {
    if (this.destroyed || this.intensity !== 'full' || this.reducedMotion) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    let stream = this.streams.get(sourceKey);
    if (!stream) {
      stream = { carry: 0, touched: false };
      this.streams.set(sourceKey, stream);
    }
    stream.touched = true;
    stream.carry += finiteDelta(deltaSeconds) * STREAM_RATE;
    const count = Math.min(6, Math.floor(stream.carry));
    stream.carry -= count;
    for (let index = 0; index < count; index += 1) {
      const paletteColor = this.streamColorIndex % 3 === 0 ? safeColor(color) : STREAM_COLORS[this.streamColorIndex % STREAM_COLORS.length];
      this.streamColorIndex += 1;
      this.spawnParticle(
        x + (Math.random() - 0.5) * 12,
        y + (Math.random() - 0.5) * 3,
        paletteColor,
        'star',
        (Math.random() - 0.5) * 64,
        -94 - Math.random() * 72,
        0.46 + Math.random() * 0.09,
        (Math.random() - 0.5) * 5.5,
      );
    }
  }

  flameBurst(x: number, y: number, intensity: number): void {
    if (this.destroyed || this.intensity !== 'full' || this.reducedMotion) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const heat = unitIntensity(intensity);
    if (heat === 0) return;
    const count = Math.max(1, Math.ceil(heat * 6));
    const spread = 4 + heat * 12;
    for (let index = 0; index < count; index += 1) {
      const fan = count === 1 ? 0 : index / (count - 1) * 2 - 1;
      this.spawnFlame(
        x + fan * spread * 0.5 + (Math.random() - 0.5) * 2.5,
        y + Math.random() * 1.5,
        heat,
        null,
        0.9 + Math.random() * 0.18,
        fan,
      );
    }
  }

  flameStream(
    x: number,
    y: number,
    deltaSeconds: number,
    intensity: number,
    sourceKey = 'default',
  ): void {
    if (this.destroyed || this.intensity !== 'full' || this.reducedMotion) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const heat = unitIntensity(intensity);
    if (heat === 0) {
      this.flameStreams.delete(sourceKey);
      return;
    }
    let stream = this.flameStreams.get(sourceKey);
    if (!stream) {
      stream = { carry: 0, touched: false };
      this.flameStreams.set(sourceKey, stream);
    }
    stream.touched = true;
    stream.carry += finiteDelta(deltaSeconds) * FLAME_STREAM_RATE * heat;
    const count = Math.min(3, Math.floor(stream.carry + 1e-9));
    stream.carry = Math.max(0, stream.carry - count);
    for (let index = 0; index < count; index += 1) {
      this.spawnFlame(
        x + (Math.random() - 0.5) * (3 + heat * 8),
        y + (Math.random() - 0.5) * 2.5,
        heat,
        sourceKey,
        0.78 + Math.random() * 0.17,
      );
    }
  }

  clearFlames(): void {
    if (this.destroyed) return;
    for (const flame of this.flames) this.releaseFlame(flame);
    this.flameStreams.clear();
  }

  update(deltaSeconds: number): void {
    if (this.destroyed) return;
    for (const [sourceKey, stream] of this.streams) {
      if (!stream.touched) this.streams.delete(sourceKey);
      else stream.touched = false;
    }
    for (const [sourceKey, stream] of this.flameStreams) {
      if (!stream.touched) this.flameStreams.delete(sourceKey);
      else stream.touched = false;
    }
    const delta = finiteDelta(deltaSeconds);
    if (delta === 0) return;
    const motion = playEffectMotionStep(delta);

    for (const pulse of this.pulses) {
      if (!pulse.active) continue;
      pulse.age += delta;
      const progress = pulse.age / pulse.lifetime;
      if (progress >= 1) {
        this.releasePulse(pulse);
        continue;
      }
      pulse.graphic.alpha = pulse.peakAlpha * (1 - smoothstep(progress));
      if (!pulse.staticTransform) pulse.graphic.scale.set(pulse.baseScale + easeOutCubic(progress) * 0.62);
    }

    for (const ring of this.rings) {
      if (!ring.active) continue;
      ring.age += delta;
      const progress = ring.age / ring.lifetime;
      if (progress >= 1) {
        this.releaseRing(ring);
        continue;
      }
      ring.graphic.alpha = 0.82 * (1 - smoothstep(progress));
      ring.graphic.scale.set(0.72 + easeOutCubic(progress) * 0.86);
    }

    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.age += delta;
      const progress = particle.age / particle.lifetime;
      if (progress >= 1) {
        this.releaseParticle(particle);
        continue;
      }
      const velocityX = particle.velocityX;
      const velocityY = particle.velocityY;
      particle.graphic.x += velocityX * motion.positionFactor;
      particle.graphic.y += velocityY * motion.positionFactor + motion.gravityPosition;
      particle.velocityX = velocityX * motion.velocityFactor;
      particle.velocityY = velocityY * motion.velocityFactor + motion.gravityVelocity;
      particle.graphic.rotation += particle.spin * delta;
      particle.graphic.alpha = progress < 0.12 ? progress / 0.12 : 1 - smoothstep((progress - 0.35) / 0.65);
      const scale = progress < 0.18
        ? 0.36 + smoothstep(progress / 0.18) * 0.72
        : 1.08 - smoothstep((progress - 0.18) / 0.82) * 0.32;
      particle.graphic.scale.set(scale);
    }

    for (const flame of this.flames) {
      if (!flame.active) continue;
      flame.age += delta;
      const progress = flame.age / flame.lifetime;
      if (progress >= 1) {
        this.releaseFlame(flame);
        continue;
      }
      flame.graphic.x += flame.velocityX * delta;
      flame.graphic.y += flame.velocityY * delta;
      flame.graphic.rotation += flame.spin * delta;
      flame.graphic.alpha = progress < 0.12
        ? smoothstep(progress / 0.12)
        : 1 - smoothstep((progress - 0.28) / 0.72);
      const taper = smoothstep(progress);
      const kindle = smoothstep(Math.min(1, progress / 0.24));
      const width = flame.baseScale * (0.9 - taper * 0.24);
      const height = flame.baseScale * (0.88 + kindle * 0.18 - taper * 0.34);
      flame.graphic.scale.set(width, height);
    }
  }

  reset(): void {
    if (this.destroyed) return;
    for (const pulse of this.pulses) this.releasePulse(pulse);
    for (const ring of this.rings) this.releaseRing(ring);
    for (const particle of this.particles) this.releaseParticle(particle);
    this.clearFlames();
    this.streams.clear();
    this.streamColorIndex = 0;
    this.emittedStars = 0;
    this.emittedParticles = 0;
    this.emittedFlames = 0;
    this.droppedParticles = 0;
    this.droppedFlames = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.reset();
    this.destroyed = true;
    for (const pulse of this.pulses) pulse.graphic.destroy();
    for (const ring of this.rings) ring.graphic.destroy();
    for (const particle of this.particles) particle.graphic.destroy();
    for (const flame of this.flames) flame.graphic.destroy();
    for (const context of Object.values(this.contexts)) context.destroy();
  }

  metrics(): PlayEffectMetrics {
    let liveParticles = 0;
    let liveFlames = 0;
    let liveRings = 0;
    let livePulses = 0;
    for (const particle of this.particles) if (particle.active) liveParticles += 1;
    for (const flame of this.flames) if (flame.active) liveFlames += 1;
    for (const ring of this.rings) if (ring.active) liveRings += 1;
    for (const pulse of this.pulses) if (pulse.active) livePulses += 1;
    return {
      liveParticles,
      pooledParticles: PARTICLE_CAP - liveParticles,
      liveFlames,
      pooledFlames: FLAME_CAP - liveFlames,
      liveRings,
      pooledRings: RING_CAP - liveRings,
      livePulses,
      pooledPulses: PULSE_CAP - livePulses,
      emittedStars: this.emittedStars,
      emittedParticles: this.emittedParticles,
      emittedFlames: this.emittedFlames,
      droppedParticles: this.droppedParticles,
      droppedFlames: this.droppedFlames,
      reducedMotion: this.reducedMotion,
    };
  }

  private prepareGraphic(graphic: Graphics): Graphics {
    graphic.visible = false;
    graphic.eventMode = 'none';
    this.layer.addChild(graphic);
    return graphic;
  }

  private spawnPulse(x: number, y: number, color: number, peakAlpha: number, baseScale: number): void {
    const pulse = this.pulses.find((candidate) => !candidate.active);
    if (!pulse) return;
    pulse.active = true;
    pulse.age = 0;
    pulse.lifetime = this.intensity === 'minimal' ? 0.18 : this.intensity === 'reduced' ? 0.2 : 0.24;
    pulse.staticTransform = this.reducedMotion || this.intensity === 'minimal';
    pulse.peakAlpha = peakAlpha;
    pulse.baseScale = baseScale;
    resetGraphic(pulse.graphic, x, y, color);
    pulse.graphic.alpha = peakAlpha;
    pulse.graphic.scale.set(baseScale);
  }

  private spawnRing(x: number, y: number, color: number, lifetime: number): void {
    const ring = this.rings.find((candidate) => !candidate.active);
    if (!ring) return;
    ring.active = true;
    ring.age = 0;
    ring.lifetime = lifetime;
    resetGraphic(ring.graphic, x, y, color);
    ring.graphic.alpha = 0.82;
    ring.graphic.scale.set(0.72);
  }

  private spawnParticle(
    x: number,
    y: number,
    color: number,
    shape: ParticleShape,
    velocityX: number,
    velocityY: number,
    lifetime: number,
    spin: number,
  ): void {
    const particle = this.particles.find((candidate) => !candidate.active);
    if (!particle) {
      this.droppedParticles += 1;
      return;
    }
    particle.graphic.context = this.contexts[shape];
    particle.active = true;
    particle.age = 0;
    particle.lifetime = Math.max(0.18, Math.min(0.55, lifetime));
    particle.velocityX = velocityX;
    particle.velocityY = velocityY;
    particle.spin = spin;
    resetGraphic(particle.graphic, x, y, color);
    particle.graphic.alpha = 0;
    particle.graphic.scale.set(0.36);
    this.emittedParticles += 1;
    if (shape === 'star') this.emittedStars += 1;
  }

  private spawnFlame(
    x: number,
    y: number,
    intensity: number,
    sourceKey: string | null,
    scaleVariation: number,
    driftBias = 0,
  ): void {
    if (sourceKey !== null) {
      let sourceCount = 0;
      for (const flame of this.flames) {
        if (flame.active && flame.sourceKey === sourceKey) sourceCount += 1;
      }
      if (sourceCount >= FLAME_SOURCE_CAP) {
        this.droppedFlames += 1;
        return;
      }
    }
    let flame: FlameSlot | undefined;
    for (const candidate of this.flames) {
      if (!candidate.active) {
        flame = candidate;
        break;
      }
    }
    if (!flame) {
      this.droppedFlames += 1;
      return;
    }
    const heat = unitIntensity(intensity);
    flame.active = true;
    flame.age = 0;
    flame.lifetime = 0.32 + Math.random() * 0.18;
    flame.velocityX = driftBias * (12 + heat * 20) + (Math.random() - 0.5) * (10 + heat * 14);
    flame.velocityY = -30 - heat * 38 - Math.random() * 16;
    flame.spin = (Math.random() - 0.5) * 0.58;
    flame.baseScale = (0.38 + heat * 0.34) * scaleVariation;
    flame.sourceKey = sourceKey;
    resetGraphic(flame.graphic, x, y, 0xffffff);
    flame.graphic.alpha = 0;
    flame.graphic.scale.set(flame.baseScale * 0.9, flame.baseScale * 0.88);
    this.emittedFlames += 1;
  }

  private releasePulse(pulse: PulseSlot): void {
    pulse.active = false;
    pulse.graphic.visible = false;
  }

  private releaseRing(ring: RingSlot): void {
    ring.active = false;
    ring.graphic.visible = false;
  }

  private releaseParticle(particle: ParticleSlot): void {
    particle.active = false;
    particle.graphic.visible = false;
  }

  private releaseFlame(flame: FlameSlot): void {
    flame.active = false;
    flame.sourceKey = null;
    flame.graphic.visible = false;
  }
}
