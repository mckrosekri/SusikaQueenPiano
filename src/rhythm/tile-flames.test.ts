import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { TileFlames } from './tile-flames';

describe('tile-attached fire', () => {
  it('keeps full flame silhouettes visible on both outer lanes at phone and desktop track widths', () => {
    for (const width of [320, 390, 480]) {
      const layer = new Container(), fire = new TileFlames(layer, 'full', false);
      const tileWidth = width / 4 - 8;
      for (const heat of [.3, .65, 1]) for (const time of [0, .17, .5, 1, 2.4]) {
        fire.beginFrame(700, time, heat, width);
        fire.draw('left', width / 8, 130, 360, tileWidth, false);
        fire.draw('right', width * 7 / 8, 130, 360, tileWidth, false);
        fire.endFrame();
        const graphics = layer.children.filter(graphic => graphic.visible);
        expect(graphics.length).toBeGreaterThan(8);
        for (const graphic of graphics) {
          const bounds = graphic.getBounds();
          expect(bounds.minX).toBeGreaterThanOrEqual(0);
          expect(bounds.maxX).toBeLessThanOrEqual(width);
        }
        expect(graphics.some(graphic => graphic.x < 12 && graphic.alpha > .1)).toBe(true);
        expect(graphics.some(graphic => graphic.x > width - 12 && graphic.alpha > .1)).toBe(true);
      }
      fire.destroy();
    }
  });
  it('rises and dissolves between frames using cached varied silhouettes without changing tile geometry', () => {
    const layer = new Container(), fire = new TileFlames(layer, 'full', false);
    fire.beginFrame(700, 1, 1, 390); fire.draw('flow', 195, 200, 500, 80, true); fire.endFrame();
    const before = layer.children.filter(graphic => graphic.visible).map(graphic => ({ y: graphic.y, alpha: graphic.alpha }));
    const contexts = new Set(layer.children.filter(graphic => graphic.visible).map(graphic => (graphic as import('pixi.js').Graphics).context));
    expect(contexts.size).toBe(4); // Three tongues and the feathered continuous rim.
    fire.beginFrame(700, 1.1, 1, 390); fire.draw('flow', 195, 200, 500, 80, true); fire.endFrame();
    const after = layer.children.filter(graphic => graphic.visible);
    expect(after.slice(2).some((graphic, index) => graphic.y < before[index + 2].y)).toBe(true);
    expect(after.slice(2).some((graphic, index) => graphic.alpha !== before[index + 2].alpha)).toBe(true);
    expect(after.every(graphic => graphic.y >= 200 && graphic.y <= 500)).toBe(true);
    fire.destroy();
  });
  it('follows a moving tile and shrinks with its consumed tail without leaving stage-side fire', () => {
    const layer = new Container(), fire = new TileFlames(layer, 'full', false);
    fire.beginFrame(700, 1, 1); fire.draw('dog', 100, 100, 500, 80, true); fire.endFrame();
    const large = fire.metrics().live;
    fire.beginFrame(700, 2, 1); fire.draw('dog', 200, 420, 500, 80, true); fire.endFrame();
    expect(fire.metrics().live).toBeLessThan(large);
    const visible = layer.children.filter(graphic => graphic.visible);
    expect(visible.every(graphic => graphic.x > 150 && graphic.x < 250 && graphic.y >= 420 && graphic.y <= 500)).toBe(true);
    expect(visible.every(graphic => graphic.x !== 0 && graphic.x !== 390)).toBe(true);
    fire.destroy();
  });
  it('keeps all graphics bounded and reuses them across dense charts', () => {
    const layer = new Container(), fire = new TileFlames(layer, 'full', false);
    const objects = [...layer.children];
    fire.beginFrame(700, 1, 1);
    for (let index = 0; index < 40; index++) fire.draw(`tile-${index}`, 100, 100, 500, 80, false);
    fire.endFrame();
    expect(fire.metrics().live).toBe(160);
    fire.beginFrame(700, 2, 1); fire.endFrame();
    expect(fire.metrics().live).toBe(0);
    expect(fire.metrics().tiles).toBe(0);
    fire.beginFrame(700, 3, 1); fire.draw('fresh', 200, 100, 300, 80, false); fire.endFrame();
    expect(fire.metrics().live).toBeGreaterThan(0);
    expect(layer.children).toEqual(objects);
    fire.destroy(); expect(layer.children).toHaveLength(0);
  });
  it('reserves both edges and top fire for a new rightmost tile after six long overlapping owners', () => {
    const layer = new Container(), fire = new TileFlames(layer, 'full', false);
    const objects = [...layer.children];
    fire.beginFrame(700, 1, 1, 390);
    for (let index = 0; index < 6; index++) fire.draw(`long-${index}`, 160, 0, 690, 70, true);
    fire.endFrame();
    fire.beginFrame(700, 1.2, 1, 390);
    for (let index = 0; index < 6; index++) fire.draw(`long-${index}`, 160, 0, 690, 70, true);
    fire.draw('right-new', 341.25, 200, 400, 89.5, false); fire.endFrame();
    const newcomer = layer.children.filter(graphic => graphic.visible && graphic.x > 280);
    expect(newcomer.some(graphic => graphic.x < 310 && graphic.y > 200)).toBe(true);
    expect(newcomer.some(graphic => graphic.x > 375 && graphic.y > 200)).toBe(true);
    expect(newcomer.some(graphic => graphic.x > 310 && graphic.x < 375 && graphic.y <= 206)).toBe(true);
    expect(fire.metrics().live).toBeLessThanOrEqual(160);
    expect(layer.children).toEqual(objects); fire.destroy();
  });
  it('clears immediately on combo error and suppresses reduced-motion fire', () => {
    const layer = new Container(), fire = new TileFlames(layer, 'full', false);
    fire.beginFrame(700, 1, 1); fire.draw('tap', 100, 100, 300, 80, false);
    fire.clear(); expect(fire.metrics().live).toBe(0);
    fire.beginFrame(700, 2, 0); fire.draw('tap', 100, 100, 300, 80, false);
    expect(fire.metrics().live).toBe(0); fire.destroy();
    for (const [mode, reduced] of [['minimal', false], ['reduced', false], ['full', true]] as const) {
      const quiet = new TileFlames(new Container(), mode, reduced);
      quiet.beginFrame(700, 1, 1); quiet.draw('tap', 100, 100, 300, 80, false);
      expect(quiet.metrics().live).toBe(0); quiet.destroy();
    }
  });
  it('clears completed tiles and safely handles invalid geometry and calls after destruction', () => {
    const fire = new TileFlames(new Container(), 'full', false);
    fire.beginFrame(700, 1, 1); fire.draw('valid', 100, 100, 300, 80, false); fire.endFrame();
    fire.beginFrame(700, 2, 1); fire.draw('invalid', NaN, 100, 300, 80, false); fire.endFrame();
    expect(fire.metrics().live).toBe(0);
    fire.destroy(); fire.beginFrame(700, 3, 1); fire.draw('late', 100, 100, 300, 80, false);
    expect(fire.metrics().live).toBe(0);
  });
});
