import { Container, Graphics, GraphicsContext } from 'pixi.js';
import type { Settings } from '../types';

const CAPACITY = 160;
interface Slot { graphic: Graphics; owner?: string }
interface Owner { slots: Slot[]; seen: boolean; phase: number; centerX: number; top: number; bottom: number; width: number; held: boolean }

// Cached, feathered edge light connects the tongues without a blur filter.
function makeRimContext(): GraphicsContext {
  return new GraphicsContext().rect(-4, 0, 8, 1).fill({ color: 0xff77a7, alpha: .08 })
    .rect(-2.5, 0, 5, 1).fill({ color: 0xffb88e, alpha: .13 })
    .rect(-1, 0, 2, 1).fill({ color: 0xffe5ba, alpha: .42 });
}

function makeTongueContext(bend: number): GraphicsContext {
  return new GraphicsContext()
    .moveTo(-6, 0).bezierCurveTo(-10, -10, -5, -20, bend, -42)
    .bezierCurveTo(bend + 4, -27, 11, -12, 6, 0).closePath().fill({ color: 0xff77a7, alpha: .13 })
    .moveTo(-4, 0).bezierCurveTo(-8, -9, -2, -17, bend, -38)
    .bezierCurveTo(bend + 3, -24, 8, -10, 4, 0).closePath().fill({ color: 0xff568b, alpha: .88 })
    .moveTo(-2.5, 0).bezierCurveTo(-5, -7, 1, -15, bend * .7, -27)
    .bezierCurveTo(4, -17, 5, -7, 2.5, 0).closePath().fill({ color: 0xffaa72, alpha: .96 })
    .moveTo(-1, 0).bezierCurveTo(-2, -5, 1, -8, bend * .35, -16)
    .bezierCurveTo(3, -9, 3, -4, 1, 0).closePath().fill({ color: 0xfff1c5, alpha: .96 });
}

/** Flames follow each tile's current rectangle, including its consumed tail and lane changes. */
export class TileFlames {
  private readonly contexts = [makeTongueContext(-4), makeTongueContext(2), makeTongueContext(5)];
  private readonly rimContext = makeRimContext();
  private readonly slots: Slot[];
  private readonly owners = new Map<string, Owner>();
  private heat = 0;
  private time = 0;
  private height = 0;
  private width = Infinity;
  private destroyed = false;

  constructor(layer: Container, private readonly mode: Settings['effects'], private readonly reducedMotion: boolean) {
    this.slots = Array.from({ length: CAPACITY }, () => {
      const graphic = new Graphics({ context: this.contexts[0] });
      graphic.visible = false;
      graphic.eventMode = 'none';
      layer.addChild(graphic);
      return { graphic };
    });
  }

  beginFrame(height: number, timeSeconds: number, heat: number, stageWidth = Infinity): void {
    if (this.destroyed) return;
    this.heat = this.mode === 'full' && !this.reducedMotion && Number.isFinite(heat) ? Math.max(0, Math.min(1, heat)) : 0;
    this.time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
    this.height = Number.isFinite(height) ? Math.max(0, height) : 0;
    this.width = Number.isFinite(stageWidth) ? Math.max(0, stageWidth) : Infinity;
    if (!this.heat || !this.height || !this.width) { this.clear(); return; }
    for (const owner of this.owners.values()) owner.seen = false;
  }

  draw(id: string, centerX: number, top: number, bottom: number, width: number, held: boolean): void {
    if (this.destroyed || !this.heat || ![centerX, top, bottom, width].every(Number.isFinite) || width <= 0) return;
    const visibleTop = Math.max(0, top), visibleBottom = Math.min(this.height, bottom);
    if (visibleBottom <= visibleTop) return;
    let owner = this.owners.get(id);
    if (!owner) {
      let seed = 0;
      for (let index = 0; index < id.length; index++) seed = (seed * 31 + id.charCodeAt(index)) >>> 0;
      owner = { slots: [], seen: true, phase: seed % 1000 / 100, centerX, top: visibleTop, bottom: visibleBottom, width, held };
      this.owners.set(id, owner);
    }
    owner.seen = true;
    owner.centerX = centerX; owner.top = visibleTop; owner.bottom = visibleBottom; owner.width = width; owner.held = held;
  }

  private paint(id: string, owner: Owner, budget: number): void {
    const { centerX, top: visibleTop, bottom: visibleBottom, width, held } = owner;
    const visibleHeight = visibleBottom - visibleTop;
    const topCount = budget >= 8 ? 4 : 0;
    const perSide = Math.min(Math.max(3, Math.min(16, Math.ceil(visibleHeight / 32))), Math.max(0, Math.floor((budget - 2 - topCount) / 2)));
    const desired = 2 + perSide * 2 + topCount;
    while (owner.slots.length > desired) {
      const slot = owner.slots.pop()!;
      slot.owner = undefined; slot.graphic.visible = false;
    }
    while (owner.slots.length < desired) {
      const slot = this.slots.find(candidate => candidate.owner === undefined);
      if (!slot) break;
      slot.owner = id; owner.slots.push(slot);
    }
    for (let index = 0; index < owner.slots.length; index++) {
      const graphic = owner.slots[index].graphic;
      const side = index % 2 === 0 ? -1 : 1;
      const edgeX = centerX + side * (width / 2 - 2);
      if (index < 2) {
        graphic.context = this.rimContext;
        graphic.position.set(Math.max(4, Math.min(this.width - 4, edgeX)), visibleTop);
        graphic.scale.set(1, visibleHeight); graphic.rotation = 0;
        graphic.alpha = .4 + this.heat * .45; graphic.visible = true;
        continue;
      }
      const tongue = index - 2, level = Math.floor(tongue / 2);
      const isTop = tongue >= perSide * 2;
      const seed = owner.phase + tongue * 2.399;
      const cycle = (this.time * (.75 + this.heat * .35) + seed) % 1;
      const envelope = Math.sin(Math.PI * cycle);
      const wave = Math.sin(this.time * 5 + seed);
      const variation = .7 + .3 * (.5 + .5 * Math.sin(seed * 7));
      graphic.context = this.contexts[tongue % this.contexts.length];
      const scale = (.5 + this.heat * .45) * variation * (.7 + envelope * .45);
      graphic.scale.set(side * scale * .88, scale * (held && level === perSide - 1 ? 1.15 : 1));
      graphic.rotation = side * wave * .055;
      // Use the actual transformed bounds to keep BOTH outer-lane edges on canvas.
      const bounds = graphic.context.bounds;
      const reach = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX)) * Math.abs(graphic.scale.x * Math.cos(graphic.rotation))
        + Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY)) * Math.abs(graphic.scale.y * Math.sin(graphic.rotation));
      const x = isTop ? centerX + ((tongue - perSide * 2) / 3 - .5) * width * .72 : edgeX;
      const y = isTop ? visibleTop + 6 : visibleTop + (level + .25 + (1 - cycle) * .55) / perSide * visibleHeight;
      graphic.position.set(Math.max(reach + 1, Math.min(this.width - reach - 1, x)), y);
      graphic.alpha = (.48 + this.heat * .4) * Math.pow(envelope, .6);
      graphic.visible = true;
    }
  }

  endFrame(): void {
    for (const [id, owner] of this.owners) {
      if (owner.seen) continue;
      for (const slot of owner.slots) { slot.owner = undefined; slot.graphic.visible = false; }
      this.owners.delete(id);
    }
    if (!this.owners.size) return;
    // Reserve a fair share before painting; an outer-lane newcomer cannot be starved by long dogs.
    const budget = Math.max(2, 2 * Math.floor(CAPACITY / this.owners.size / 2));
    for (const owner of this.owners.values()) while (owner.slots.length > budget) {
      const slot = owner.slots.pop()!;
      slot.owner = undefined; slot.graphic.visible = false;
    }
    for (const [id, owner] of this.owners) this.paint(id, owner, budget);
  }

  clear(): void {
    this.heat = 0;
    for (const slot of this.slots) { slot.owner = undefined; slot.graphic.visible = false; }
    this.owners.clear();
  }

  metrics() { return { live: this.slots.filter(slot => slot.graphic.visible).length, capacity: CAPACITY, tiles: this.owners.size }; }

  destroy(): void {
    if (this.destroyed) return;
    this.clear(); this.destroyed = true;
    for (const slot of this.slots) slot.graphic.destroy();
    for (const context of this.contexts) context.destroy();
    this.rimContext.destroy();
  }
}
