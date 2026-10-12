import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Volume2, X } from 'lucide-react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Application, Container, FillGradient, Graphics } from 'pixi.js';
import type { Chart, Note, RunConfig, RunResult, Settings, Song } from '../types';
import { AudioTransport } from '../audio/transport';
import { JudgementEngine, laneAt, type HitFeedback } from '../rhythm/judgement';
import { TILE_BEAT_LINE_RATIO, tileRectAtTime, tileTimeBounds } from '../rhythm/tile-layout';
import { isTileHitEligible, pickTileHitTarget } from '../rhythm/tile-hit-target';
import { capturePointerSafely } from '../rhythm/pointer-capture';
import { advanceSustainConsumption, remainingSlideRibbon, streamingSustainGeometry } from '../rhythm/sustain-visual';
import { PlayEffects } from '../rhythm/play-effects';
import { TileFlames } from '../rhythm/tile-flames';
import { comboVisualState } from '../rhythm/combo-visual';
import { playbackView } from '../rhythm/playback-view';
import { reportDiagnostic } from '../services/diagnostics';

interface Props {
  song: Song;
  chart: Chart;
  config: RunConfig;
  settings: Settings;
  tutorial?: boolean;
  onTutorialComplete?: () => void;
  onFinish: (result: RunResult) => void;
  onExit: () => void;
}

interface NoteVisual {
  root: Container;
  art: Container;
  mask: Graphics;
  edge: Graphics;
  body: Graphics;
  face: Graphics;
  symbol: Graphics;
  detail: Graphics;
  legs: Graphics[];
  signature?: string;
  echoAge?: number;
  echoX?: number;
  echoY?: number;
  note?: Note;
}

interface TileTarget {
  note: Note;
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
  exact: boolean;
  status: 'pending' | 'active';
}

interface SustainVisual {
  consumed: number;
  x: number;
  y: number;
  following: boolean;
  connected: boolean;
}

export default function GameStage({
  song,
  chart,
  config,
  settings,
  tutorial,
  onTutorialComplete,
  onFinish,
  onExit,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLElement>(null);
  const controls = useRef<{ pause: () => void; resume: () => Promise<void>; restart: () => Promise<void> } | undefined>(undefined);
  const [state, setState] = useState<'loading' | 'ready' | 'playing' | 'paused' | 'error'>('loading');
  const [error, setError] = useState('');
  const [hud, setHud] = useState({ tiles: 0, streak: 0, progress: 0, feedback: '', countdown: '' });
  const celebration = useRef<HTMLSpanElement>(null);
  const streakValue = useRef<HTMLElement>(null);
  const callbacks = useRef({ onFinish, onExit });
  callbacks.current = { onFinish, onExit };

  useEffect(() => {
    let disposed = false;
    let running = false;
    let finished = false;
    let lastFrame = 0;
    let hudAt = 0;
    let feedbackUntil = 0;
    let lastFeedback = '';
    let cleanupNative: (() => void) | undefined;
    let engine!: JudgementEngine;
    let width = 400;
    let height = 700;
    let laneWidth = 100;
    let finishAtMs = config.endMs ?? chart.durationMs;

    const abort = new AbortController();
    const app = new Application();
    const transport = new AudioTransport();
    let playableFromMs = config.startMs;
    let resuming = false;
    const viewAt = (timestamp?: number) => playbackView(transport.sourceTimeAt(timestamp), playableFromMs, settings.calibrationMs, config.rate, resuming);
    const engineTime = (timestamp?: number) => viewAt(timestamp).timeMs;
    const activePointers = new Map<number, { lane: number; noteId: string; x: number; y: number }>();
    const sustains = new Map<string, SustainVisual>();
    const visualPool: NoteVisual[] = [];
    const mapped = new Map<string, NoteVisual>();
    const renderedTargets = new Map<string, TileTarget>();
    let lastPaintAt = -Infinity;
    const feedbackPositions = new Map<number, { x: number; y: number }>();
    const satinFills = new Map<number, FillGradient>();
    const satinFill = (color: number) => {
      let gradient = satinFills.get(color);
      if (!gradient) {
        const tint = (amount: number) => [16, 8, 0].reduce((value, shift) => {
          const channel = (color >> shift) & 255;
          return value | Math.round(amount > 0 ? channel + (255 - channel) * amount : channel * (1 + amount)) << shift;
        }, 0);
        gradient = new FillGradient({
          start: { x: 0, y: 0 }, end: { x: .8, y: 1 }, textureSize: 64,
          colorStops: [{ offset: 0, color: tint(.18) }, { offset: .3, color }, { offset: 1, color: tint(-.14) }],
        });
        satinFills.set(color, gradient);
      }
      return gradient;
    };
    const frameTimes: number[] = [];
    const stage = new Container();
    const background = new Graphics();
    const laneLightLayer = new Container();
    const laneLights = Array.from({ length: 4 }, () => new Graphics());
    const laneEnergy = [0, 0, 0, 0];
    laneLightLayer.addChild(...laneLights);
    const ribbonLayer = new Graphics();
    const effectsLayer = new Container();
    const tileFireLayer = new Container();
    const keyPointers: Record<string, number> = { KeyD: -1, KeyF: -2, KeyJ: -3, KeyK: -4 };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const effects = new PlayEffects(effectsLayer, settings.effects, reducedMotion);
    const tileFire = new TileFlames(tileFireLayer, settings.effects, reducedMotion);
    let motionTime = 0;
    let lastMilestone = 0;
    let displayedHeat = 0;
    const updateHeat = (heat: number) => {
      displayedHeat = heat;
      screen.current?.style.setProperty('--combo-heat', heat.toFixed(3));
    };
    const noteById = new Map(chart.notes.map(note => [note.id, note]));
    let statesById = new Map<string, JudgementEngine['states'][number]>();
    const devApi = {
      transport,
      chart,
      config,
      getMetrics: () => transport.metrics(),
      getEngine: () => engine,
      getStates: () => engine?.states ?? [],
      getSustainEffects: () => [...sustains].map(([id, effect]) => {
        const note = noteById.get(id)!;
        const raw = tileRectAtTime(chart, note, config.rate, engineTime(), height);
        return { id, ...effect, ...streamingSustainGeometry(raw.bottom, height * TILE_BEAT_LINE_RATIO, raw.height, effect.consumed) };
      }),
      getEffectMetrics: () => ({ ...effects.metrics(), reducedMotion, tileVisuals: visualPool.length }),
      getTileRects: () => [...renderedTargets.values()].map((target) => ({
        id: target.note.id,
        top: target.top,
        bottom: target.bottom,
        left: target.left,
        right: target.right,
        kind: target.note.kind,
        lane: target.note.lane,
        status: target.status,
      })),
      getPerformance: () => {
        const samples = [...frameTimes].sort((first, second) => first - second);
        return {
          frames: samples.length,
          p95Ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
          droppedPercent: samples.filter((sample) => sample > 25).length / Math.max(1, samples.length) * 100,
        };
      },
    };
    const devWindow = window as unknown as { __afterbeat?: unknown };
    if (import.meta.env.DEV) devWindow.__afterbeat = devApi;

    const feedback = (hit: HitFeedback) => {
      const sustain = hit.kind === 'hold' || hit.kind === 'slide';
      lastFeedback = sustain && hit.phase === 'start' ? (hit.kind === 'hold' ? 'HOLD TO THE TAIL' : 'FOLLOW THE RIBBON')
        : sustain && hit.judgement === 'perfect' ? (hit.kind === 'hold' ? 'HAPPY PUP!' : 'LOVELY SLIDE!')
        : sustain && (hit.credit ?? 0) > 0 && hit.judgement !== 'perfect' ? (hit.kind === 'hold' ? 'PARTIAL HOLD' : 'PARTIAL SLIDE')
        : hit.judgement === 'miss'
        ? 'MISSED'
        : !sustain && hit.judgement === 'perfect' ? 'ON BEAT · 100%'
        : !sustain ? `${hit.errorMs < 0 ? 'EARLY' : 'LATE'} · ${Math.min(99, Math.floor((hit.credit ?? 1) * 100))}%`
        : hit.combo >= 12
          ? 'GREAT STREAK'
          : hit.combo >= 4
            ? 'NICE STREAK'
            : 'NICE';
      feedbackUntil = performance.now() + 560;
      const combo = comboVisualState(hit.combo);
      if (hit.phase !== 'start' && hit.combo === 0) {
        lastMilestone = 0;
        effects.clearFlames();
        tileFire.clear();
        updateHeat(0);
        setHud(previous => ({ ...previous, streak: 0, feedback: lastFeedback }));
      }
      if (hit.judgement === 'miss') { lastMilestone = 0; return; }
      const position = feedbackPositions.get(hit.lane) ?? {
        x: (hit.lane + 0.5) * laneWidth, y: height * TILE_BEAT_LINE_RATIO,
      };
      const complete = sustain && hit.phase === 'complete';
      if (hit.phase === 'complete' && hit.judgement === 'perfect' && combo.heat > 0) {
        effects.flameBurst(position.x, position.y, combo.heat);
      }
      if (!complete || hit.judgement === 'perfect') {
        effects.hit(position.x, position.y, hit.kind === 'hold' ? 0xffbbcf : hit.kind === 'slide' ? 0xe4c9ff : 0xffefcf, hit.kind, complete);
        laneEnergy[Math.max(0, Math.min(3, Math.round(hit.lane)))] = 1;
      }
      if (!reducedMotion && settings.effects === 'full') {
        if (hit.combo > 0 && !complete) streakValue.current?.animate([
          { transform: 'scale(1.14)', color: '#c14c85' }, { transform: 'scale(1)', color: '#351b3d' },
        ], { duration: 170, easing: 'cubic-bezier(.16,1,.3,1)' });
        const milestone = combo.tier;
        if (milestone > lastMilestone || complete && hit.judgement === 'perfect') {
          lastMilestone = milestone;
          celebration.current?.animate([
            { transform: 'translateY(6px) scale(.9)', opacity: 0 },
            { transform: 'translateY(0) scale(1.04)', opacity: 1, offset: .22 },
            { transform: 'translateY(-4px) scale(1)', opacity: 1, offset: .75 },
            { transform: 'translateY(-10px) scale(1)', opacity: 0 },
          ], { duration: 650, easing: 'ease-out' });
        }
      }
      if (complete) return;
      transport.feedback(hit.lane, settings.feedbackVolume);
      if (settings.haptics && Capacitor.isNativePlatform()) {
        void Haptics.impact({ style: ImpactStyle.Light }).catch((hapticError) => reportDiagnostic(hapticError, {
          operation: 'feedback.haptic',
          fallback: 'visual_feedback',
        }));
      }
    };

    const resetEngine = () => {
      sustains.clear();
      engine = new JudgementEngine(chart, config, song.id, feedback);
      statesById = new Map(engine.states.map(state => [state.note.id, state]));
      lastMilestone = 0;
      updateHeat(0);
      effects.clearFlames();
      tileFire.clear();
      setHud({ tiles: 0, streak: 0, progress: 0, feedback: '', countdown: '' });
      finishAtMs = Math.max(
        config.endMs ?? chart.durationMs,
        ...engine.states.map(({ note }) => tileTimeBounds(chart, note, config.rate).exitMs),
      ) + 50 * config.rate;
    };

    const resetVisuals = () => {
      for (const visual of mapped.values()) {
        visual.root.visible = false;
        visual.note = undefined;
      }
      mapped.clear();
      renderedTargets.clear();
      activePointers.clear();
      feedbackPositions.clear();
      for (const visual of visualPool) {
        visual.root.visible = false;
        visual.root.alpha = 1;
        visual.root.scale.set(1);
        visual.note = undefined;
        visual.echoAge = undefined;
      }
      laneEnergy.fill(0);
      effects.reset();
      tileFire.clear();
    };

    const pause = () => {
      if (!running || finished) return;
      running = false;
      const time = engineTime();
      transport.pause();
      engine.suspend(time);
      activePointers.clear();
      for (const effect of sustains.values()) { effect.connected = false; effect.following = false; }
      for (const animation of celebration.current?.getAnimations() ?? []) animation.cancel();
      for (const animation of streakValue.current?.getAnimations() ?? []) animation.cancel();
      setState('paused');
    };

    const start = async (from = config.startMs, resume = false) => {
      try {
        if (disposed) return;
        resetVisuals();
        playableFromMs = from;
        resuming = resume;
        await transport.start(from, 2.5);
        if (disposed) return;
        lastFrame = performance.now();
        running = true;
        setState('playing');
      } catch (startError) {
        reportDiagnostic(startError, { operation: 'playback.start' });
        setError('Audio could not start. Try again or choose another song.');
        setState('error');
      }
    };

    controls.current = {
      pause,
      resume: async () => start(transport.sourceTimeAt(), true),
      restart: async () => {
        finished = false;
        resetEngine();
        await start();
      },
    };

    const hide = () => {
      if (document.hidden) pause();
    };
    const blur = () => pause();
    const audioInterrupted = () => pause();
    const contextChanged = () => {
      if (running && transport.context.state !== 'running') pause();
    };
    transport.context.addEventListener('statechange', contextChanged);

    const eventView = (event: PointerEvent | KeyboardEvent) => {
      const timestamp = event.timeStamp > 1e12 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
      return viewAt(timestamp);
    };
    const eventTime = (event: PointerEvent | KeyboardEvent) => eventView(event).timeMs;

    const targetAt = (x: number, y: number, timeMs: number, timestamp: number): TileTarget | undefined => {
      const targets: TileTarget[] = [];
      for (const noteState of engine.states) {
        if (!isTileHitEligible(noteState)) continue;
        const rawRect = tileRectAtTime(chart, noteState.note, config.rate, timeMs, height);
        const effect = sustains.get(noteState.note.id);
        const rect = effect ? { ...rawRect, ...streamingSustainGeometry(rawRect.bottom, height * TILE_BEAT_LINE_RATIO, rawRect.height, effect.consumed) } : rawRect;
        if (!rect.visible || !rect.interactable) continue;
        const centerX = (laneAt(noteState.note, timeMs) + 0.5) * laneWidth;
        const halfWidth = Math.max(24, (laneWidth - 8) / 2);
        const left = centerX - halfWidth;
        const right = centerX + halfWidth;
        targets.push({
            note: noteState.note,
            left,
            right,
            top: rect.top,
            bottom: rect.bottom,
            centerX,
            centerY: (rect.top + rect.bottom) / 2,
            exact: false,
            status: noteState.status,
          });
      }
      const eligible = new Set(targets.map(target => target.note.id));
      const painted = [...renderedTargets.values()].filter(target => eligible.has(target.note.id));
      return pickTileHitTarget(x, y, targets, painted, timestamp - lastPaintAt);
    };

    const canvasPoint = (event: PointerEvent) => {
      const bounds = app.canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - bounds.left) / bounds.width) * width,
        y: ((event.clientY - bounds.top) / bounds.height) * height,
      };
    };

    const captureSustain = (note: Note, timeMs: number, point: { x: number; y: number }) => {
      if (note.kind !== 'hold' && note.kind !== 'slide') return;
      const existing = sustains.get(note.id);
      if (existing) {
        existing.x = point.x; existing.y = point.y;
        existing.connected = true; existing.following = true;
      } else {
        sustains.set(note.id, {
          consumed: advanceSustainConsumption(0, note.timeMs, note.endTimeMs ?? note.timeMs, timeMs, true, true),
          x: point.x, y: point.y, following: true, connected: true });
      }
    };

    const down = (event: PointerEvent) => {
      if (!running || activePointers.size >= 2) return;
      const inputView = eventView(event);
      if (!inputView.acceptsInput) return;
      const timeMs = inputView.timeMs;
      const point = canvasPoint(event);
      const timestamp = event.timeStamp > 1e12 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
      const target = targetAt(point.x, point.y, timeMs, timestamp);
      const lane = Math.max(-0.5, Math.min(3.5, point.x / laneWidth - 0.5));
      if (!target) { engine.breakCombo(lane); return; }
      event.preventDefault();
      feedbackPositions.set(target.note.lane, point);
      feedbackPositions.set(lane, point);
      if (!engine.pointerDown(event.pointerId, lane, timeMs, target.note.id)) return;
      activePointers.set(event.pointerId, { lane, noteId: target.note.id, ...point });
      captureSustain(target.note, timeMs, point);
      capturePointerSafely(app.canvas, event.pointerId, () => up(event));
    };

    const move = (event: PointerEvent) => {
      const active = activePointers.get(event.pointerId);
      if (!running || !active) return;
      event.preventDefault();
      const point = canvasPoint(event);
      const lane = Math.max(-0.5, Math.min(3.5, point.x / laneWidth - 0.5));
      active.lane = lane;
      active.x = point.x; active.y = point.y;
      const note = noteById.get(active.noteId);
      if (note) feedbackPositions.set(note.lane, point);
      engine.pointerMove(event.pointerId, lane, eventTime(event));
    };

    const up = (event: PointerEvent) => {
      if (!activePointers.has(event.pointerId)) return;
      engine.pointerUp(event.pointerId, eventTime(event));
      activePointers.delete(event.pointerId);
    };

    const keyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        event.preventDefault();
        pause();
        return;
      }
      const pointer = keyPointers[event.code];
      if (pointer === undefined || event.repeat || !running || activePointers.size >= 2) return;
      const inputView = eventView(event);
      if (!inputView.acceptsInput) return;
      event.preventDefault();
      const lane = Object.keys(keyPointers).indexOf(event.code);
      const timeMs = inputView.timeMs;
      const candidate = engine.keyboardTarget(lane, timeMs);
      if (!candidate) { engine.breakCombo(lane); return; }
      const target = { note: candidate.note, rect: tileRectAtTime(chart, candidate.note, config.rate, timeMs, height) };
      const sustainedTarget = target?.note.kind === 'hold' || target?.note.kind === 'slide';
      const point = { x: (lane + 0.5) * laneWidth, y: Math.max(20, Math.min(height - 20,
        sustainedTarget ? height * TILE_BEAT_LINE_RATIO : target ? (target.rect.top + target.rect.bottom) / 2 : height * TILE_BEAT_LINE_RATIO)) };
      if (target) feedbackPositions.set(lane, point);
      if (!engine.pointerDown(pointer, lane, timeMs, target.note.id)) return;
      activePointers.set(pointer, { lane, noteId: target?.note.id ?? '', ...point });
      if (target) captureSustain(target.note, timeMs, point);
    };

    const keyUp = (event: KeyboardEvent) => {
      const pointer = keyPointers[event.code];
      if (pointer !== undefined && activePointers.has(pointer)) {
        engine.pointerUp(pointer, eventTime(event));
        activePointers.delete(pointer);
      }
    };

    const resize = () => {
      if (!host.current) return;
      width = host.current.clientWidth;
      height = host.current.clientHeight;
      laneWidth = width / 4;
      renderedTargets.clear();
      lastPaintAt = -Infinity;
      app.renderer.resize(width, height);
      background.clear().rect(0, 0, width, height).fill(0xe9b7cf);
      const laneColors = [0xf4cfdd, 0xddcfee, 0xf8dbe3, 0xd7c9ed];
      for (let lane = 0; lane < 4; lane += 1) {
        background
          .rect(lane * laneWidth + 1, 0, laneWidth - 2, height)
          .fill(laneColors[lane])
          .moveTo(lane * laneWidth, 0)
          .lineTo(lane * laneWidth, height)
          .stroke({ color: 0xfffbf3, width: 1, alpha: 0.75 });
        // Static satin shading and narrow side rails keep the track crisp.
        for (let strip = 0; strip < 8; strip += 1) {
          background.rect(lane * laneWidth + strip * laneWidth / 8, 0, laneWidth / 8, height)
            .fill({ color: 0xffffff, alpha: Math.sin(strip / 7 * Math.PI) * 0.11 });
        }
        const light = laneLights[lane].clear();
        for (let band = 0; band < 12; band += 1) {
          light.rect(lane * laneWidth + 2, height * band / 12, laneWidth - 4, height / 12 + 1)
            .fill({ color: 0xfff9ef, alpha: 0.08 + band / 12 * 0.42 });
        }
        light.alpha = 0;
      }
      background.rect(0, 0, 2, height).fill({ color: 0xffffff, alpha: .72 })
        .rect(width - 2, 0, 2, height).fill({ color: 0xffffff, alpha: .72 });
      background.rect(0, height - 54, width, 54).fill({ color: 0x43203f, alpha: 0.15 });
      const cueY = height * TILE_BEAT_LINE_RATIO;
      const band = height * .045;
      background.rect(0, cueY - band, width, band * 2).fill({ color: 0xfffbf3, alpha: .16 });
      background.moveTo(0, cueY).lineTo(width, cueY).stroke({ color: 0xe580ae, width: 7, alpha: .22 })
        .moveTo(0, cueY).lineTo(width, cueY).stroke({ color: 0xfffbf3, width: 2, alpha: .95 });
    };

    const makeVisual = (): NoteVisual => {
      const root = new Container();
      const art = new Container();
      const mask = new Graphics().rect(0, 0, 1, 1).fill(0xffffff);
      const edge = new Graphics();
      const body = new Graphics();
      const face = new Graphics();
      const symbol = new Graphics();
      const detail = new Graphics();
      const legs = Array.from({ length: 4 }, () => new Graphics());
      art.addChild(body, detail, ...legs, face, symbol);
      root.addChild(art, mask, edge);
      stage.addChild(root);
      root.visible = false;
      return { root, art, mask, edge, body, face, symbol, detail, legs };
    };

    const drawNote = (visual: NoteVisual, note: Note, timeMs: number, active: boolean, status: 'pending' | 'active') => {
      const rawRect = tileRectAtTime(chart, note, config.rate, timeMs, height);
      const effect = sustains.get(note.id);
      const rect = effect ? { ...rawRect, ...streamingSustainGeometry(rawRect.bottom, height * TILE_BEAT_LINE_RATIO, rawRect.height, effect.consumed) } : rawRect;
      const centerX = (laneAt(note, timeMs) + 0.5) * laneWidth;
      const tileWidth = Math.max(48, laneWidth - 8);
      const tileHeight = rawRect.height;
      const glowing = !!effect?.connected && effect.following;
      const fireTop = note.kind === 'slide' ? Math.max(rect.top, rect.bottom - Math.min(30, Math.max(22, tileHeight * .2))) : rect.top;
      tileFire.draw(note.id, centerX, fireTop, rect.bottom, note.kind === 'slide' ? tileWidth * .68 : tileWidth, glowing);
      const signature = `${note.kind}:${note.direction}:${tileWidth}:${tileHeight}:${settings.skin}`;
      const cream = 0xffead6, characterInk = 0x4d2739, pearl = 0xfff2f6;
      const headRadius = Math.min(tileWidth * .29, Math.max(17, tileHeight * .18));
      const originalHeadY = Math.max(headRadius + 7, tileHeight - headRadius - 7);
      const bodyWidth = tileWidth * .7;
      const bodyTop = Math.min(8, tileHeight * .08);
      const bodyBottom = Math.max(bodyTop + 24, originalHeadY + headRadius * .42);
      const headY = effect ? Math.max(headRadius, rect.height - headRadius - 7) : originalHeadY;

      visual.body.position.set(0, 0);
      visual.face.position.set(0, 0);
      visual.detail.position.set(0, 0);

      visual.root.visible = rect.visible && rect.height > 0;
      visual.root.position.set(centerX, rect.top);
      visual.root.alpha = 1;
      visual.root.scale.set(1);
      // Build each pooled tile once. Travel, face position and paw motion use transforms.
      if (visual.signature !== signature) {
        visual.signature = signature;
        visual.body.clear(); visual.face.clear(); visual.symbol.clear(); visual.detail.clear(); visual.edge.clear();
        for (const leg of visual.legs) { leg.clear(); leg.visible = note.kind === 'hold'; }
        visual.face.position.set(0, 0); visual.symbol.position.set(0, 0);
        visual.detail.position.set(0, 0);
        const tileColor = settings.skin === 'crimson' ? 0x92506e : settings.skin === 'silver' ? 0x817087 : 0x765381;
        const fill = note.kind === 'slide' ? 0xab5192 : note.kind === 'flick' ? 0x8b609a : tileColor;
        if (note.kind === 'hold') {
          visual.body.roundRect(-tileWidth / 2, 0, tileWidth, tileHeight, Math.min(12, tileWidth * .12))
            .fill(0xffd6df).stroke({ color: pearl, width: 1, alpha: .72 })
            .roundRect(-bodyWidth / 2, bodyTop, bodyWidth, bodyBottom - bodyTop, bodyWidth / 2).fill(0xb86670)
            .roundRect(-bodyWidth / 2 + 5, bodyTop + 9, bodyWidth * .2, Math.max(12, bodyBottom - bodyTop - 25), bodyWidth * .1)
            .fill({ color: 0xffccbd, alpha: .23 });
          const shoulderY = bodyTop + Math.max(16, (bodyBottom - bodyTop) * .28);
          const hipY = bodyTop + Math.max(30, (bodyBottom - bodyTop) * .64);
          const legLength = Math.min(15, tileWidth * .15);
          [[-1, shoulderY], [1, shoulderY], [-1, hipY], [1, hipY]].forEach(([side, legY], index) => {
            const leg = visual.legs[index];
            leg.position.set(side * (bodyWidth / 2 - 4), legY);
            leg.moveTo(0, 0).quadraticCurveTo(side * legLength * .65, 1, side * legLength, 5)
              .stroke({ color: characterInk, width: 6, cap: 'round' })
              .ellipse(side * legLength, 5, 4.2, 3.4).fill(cream);
          });
          visual.detail.moveTo(0, bodyTop + 4).bezierCurveTo(-4, bodyTop - 8, 12, bodyTop - 13, 15, bodyTop - 3)
            .stroke({ color: characterInk, width: 4, cap: 'round' });
          // The face keeps its proportions as the body is eaten; the final cap clips away.
          visual.face.circle(0, 0, headRadius).fill(0xd98d91)
            .roundRect(-headRadius * 1.18, -headRadius * .46, headRadius * .58, headRadius * 1.14, headRadius * .28).fill(0x7d3f55)
            .roundRect(headRadius * .6, -headRadius * .46, headRadius * .58, headRadius * 1.14, headRadius * .28).fill(0x7d3f55)
            .circle(0, headRadius * .24, headRadius * .58).fill(cream)
            .circle(-headRadius * .35, -headRadius * .19, Math.max(2, headRadius * .09)).fill(characterInk)
            .circle(headRadius * .35, -headRadius * .19, Math.max(2, headRadius * .09)).fill(characterInk)
            .circle(-headRadius * .57, headRadius * .17, headRadius * .15).fill({ color: 0xffadc7, alpha: .65 })
            .circle(headRadius * .57, headRadius * .17, headRadius * .15).fill({ color: 0xffadc7, alpha: .65 })
            .circle(0, headRadius * .17, Math.max(3, headRadius * .14)).fill(0x351b3d);
          visual.symbol.moveTo(-headRadius * .18, headRadius * .42)
            .quadraticCurveTo(0, headRadius * .56, headRadius * .18, headRadius * .42)
            .stroke({ color: characterInk, width: 1.8, cap: 'round' })
            .moveTo(headRadius * .45, -headRadius * .7).lineTo(headRadius * .08, -headRadius * .93)
            .lineTo(headRadius * .15, -headRadius * .55).closePath().fill(0xf24f91)
            .moveTo(headRadius * .45, -headRadius * .7).lineTo(headRadius * .82, -headRadius * .93)
            .lineTo(headRadius * .75, -headRadius * .55).closePath().fill(0xf24f91)
            .circle(headRadius * .45, -headRadius * .7, Math.max(3, headRadius * .13)).fill(0xffe7c7);
        } else if (note.kind === 'slide') {
          const padWidth = tileWidth * .68;
          const padHeight = Math.min(30, Math.max(22, tileHeight * .2));
          const padTop = tileHeight - padHeight;
          visual.body.roundRect(-padWidth / 2, padTop, padWidth, padHeight, Math.min(10, padHeight * .36))
            .fill(satinFill(fill)).stroke({ color: pearl, width: 1, alpha: .4 });
          const direction = note.direction ?? 1;
          visual.symbol.moveTo(-direction * 10, -9).lineTo(direction * 5, 0).lineTo(-direction * 10, 9)
            .stroke({ color: cream, width: 3, cap: 'round', join: 'round' });
        } else {
          visual.body.roundRect(-tileWidth / 2, 0, tileWidth, tileHeight, 9).fill(satinFill(fill))
            .stroke({ color: pearl, width: 1, alpha: .32 });
          if (note.kind === 'flick') {
            const direction = note.direction ?? 1;
            const y = tileHeight / 2;
            visual.symbol.moveTo(-direction * 10, y - 9).lineTo(direction * 5, y).lineTo(-direction * 10, y + 9)
              .stroke({ color: cream, width: 3, cap: 'round', join: 'round' });
          }
        }
        // Prebuilt eating edge; only its position and opacity change per frame.
        visual.edge.moveTo(-tileWidth / 2 + 5, 0).lineTo(tileWidth / 2 - 5, 0)
          .stroke({ color: 0xfff1ca, width: 10, alpha: .24 })
          .moveTo(-tileWidth / 2 + 5, 0).lineTo(tileWidth / 2 - 5, 0)
          .stroke({ color: 0xffffff, width: 2.5, alpha: .95 })
          .circle(0, 0, 7).fill({ color: 0xfff8e9, alpha: .85 });
      }
      visual.body.alpha = glowing ? .94 : 1;
      visual.edge.visible = !!effect;
      visual.mask.visible = !!effect;
      visual.edge.y = rect.height;
      visual.edge.alpha = glowing ? (settings.effects === 'full' && !reducedMotion ? .87 + Math.sin(motionTime * 8) * .1 : .9) : .3;
      if (effect) {
        visual.mask.position.set(-tileWidth / 2 - 2, 0);
        visual.mask.scale.set(tileWidth + 4, rect.height);
        visual.art.mask = visual.mask;
      } else visual.art.mask = null;
      if (note.kind === 'hold') {
        visual.face.y = headY;
        visual.symbol.y = headY;
        for (let index = 0; index < visual.legs.length; index += 1) {
          visual.legs[index].rotation = settings.effects === 'full' && !reducedMotion
            ? Math.sin(motionTime * (glowing ? 12 : 5) + index * Math.PI / 2 + note.lane) * (glowing ? .16 : .07) : 0;
        }
      }
      if (note.kind === 'slide') {
        const artShift = effect ? rect.height - tileHeight : 0;
        visual.body.y = artShift;
        visual.face.y = artShift;
        visual.detail.y = artShift;
        // Keep the direction cue inside the moving head above the eating edge.
        visual.symbol.y = effect ? Math.max(12, rect.height - 15) : Math.max(15, tileHeight - 15);
      }
      if (note.kind === 'slide' && note.targetLane !== undefined) {
        const end = note.endTimeMs ?? note.timeMs;
        const path = note.path ?? [{ timeMs: note.timeMs, lane: note.lane }, { timeMs: end, lane: note.targetLane }];
        const points = remainingSlideRibbon(path, effect ? timeMs : note.timeMs, end, rect.bottom, rect.height)
          .map(point => ({ x: (point.lane + .5) * laneWidth, y: point.y }));
        if (points.length === 1) points.push({ x: points[0].x, y: rect.top });
        for (const [color, lineWidth, alpha] of [[0xfff4fa, Math.max(12, laneWidth * .19), .86], [0xbd6db0, Math.max(5, laneWidth * .075), .9], [0xffffff, 1.5, .7]]) {
          ribbonLayer.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i += 1) ribbonLayer.lineTo(points[i].x, points[i].y);
          ribbonLayer.stroke({ color, width: lineWidth, cap: 'round', join: 'round', alpha: active ? alpha : alpha * .8 });
        }
      }
      renderedTargets.set(note.id, { note, left: centerX - tileWidth / 2, right: centerX + tileWidth / 2,
        top: rect.top, bottom: rect.bottom, centerX, centerY: (rect.top + rect.bottom) / 2, exact: true, status });
    };

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const elapsedMs = now - lastFrame;
      const deltaSeconds = Math.min(0.05, elapsedMs / 1000 || 0.016);
      lastFrame = now;
      if (!running) return;
      const view = viewAt(now);
      const timeMs = view.timeMs;
      motionTime += deltaSeconds;
      if (view.acceptsInput && timeMs > config.startMs + 1000 && frameTimes.length < 36_000) frameTimes.push(elapsedMs);
      if (view.acceptsInput) engine.update(timeMs);
      const combo = comboVisualState(engine.combo);
      const targetHeat = settings.effects === 'full' && !reducedMotion ? combo.heat : combo.heat * .2;
      updateHeat(targetHeat === 0 ? 0 : displayedHeat + (targetHeat - displayedHeat) * (1 - Math.exp(-deltaSeconds * 9)));
      tileFire.beginFrame(height, motionTime, combo.heat, width);
      for (const [id, effect] of sustains) {
        const noteState = statesById.get(id);
        if (!noteState || noteState.status === 'done') { sustains.delete(id); continue; }
        const pointer = noteState.pointer === undefined ? undefined : activePointers.get(noteState.pointer);
        effect.connected = !!pointer;
        effect.following = !!pointer && Math.abs(pointer.lane - laneAt(noteState.note, timeMs)) <= 0.78;
        if (pointer) { effect.x = pointer.x; effect.y = pointer.y; }
        const before = effect.consumed;
        // The tail follows the song even while released. Input validity controls
        // sparkle/scoring; it cannot pause or reposition the musical stream.
        effect.consumed = advanceSustainConsumption(before, noteState.note.timeMs, noteState.note.endTimeMs ?? noteState.note.timeMs, timeMs, true, true);
        if (effect.connected && effect.following && effect.consumed > before) {
          effects.stream(effect.x, effect.y, deltaSeconds, noteState.note.kind === 'slide' ? 0xe4c9ff : 0xffd7bc, id);
          const lane = Math.max(0, Math.min(3, Math.round(laneAt(noteState.note, timeMs))));
          laneEnergy[lane] = Math.max(laneEnergy[lane], .55);
        }
      }
      for (let lane = 0; lane < 4; lane += 1) {
        laneEnergy[lane] *= Math.exp(-deltaSeconds * 9);
        laneLights[lane].alpha = Math.min(.95, laneEnergy[lane] * (settings.effects === 'minimal' || reducedMotion ? .22 : .7 + combo.heat * .25));
      }
      ribbonLayer.clear();
      renderedTargets.clear();
      const visible = new Set<string>();

      for (const noteState of engine.states) {
        if (noteState.status === 'done') continue;
        const rect = tileRectAtTime(chart, noteState.note, config.rate, timeMs, height);
        if (!rect.visible) continue;
        visible.add(noteState.note.id);
        let visual = mapped.get(noteState.note.id);
        if (!visual) {
          visual = visualPool.find((candidate) => !candidate.note);
          if (!visual) {
            visual = makeVisual();
            visualPool.push(visual);
          }
          visual.note = noteState.note;
          mapped.set(noteState.note.id, visual);
        }
        drawNote(visual, noteState.note, timeMs, noteState.status === 'active', noteState.status);
      }

      for (const [id, visual] of mapped) {
        if (visible.has(id)) continue;
        const noteState = statesById.get(id);
        if (settings.effects !== 'minimal' && !reducedMotion && noteState?.status === 'done'
          && noteState.judgement !== 'miss' && (noteState.note.kind === 'tap' || noteState.note.kind === 'flick')) {
          // Retain only decorative art briefly; completed tiles leave hit testing immediately.
          visual.echoAge = 0;
          visual.root.visible = true;
          visual.echoX = visual.root.x;
          visual.echoY = visual.root.y;
          visual.edge.visible = true;
          visual.edge.y = Math.min(visual.root.height, 8);
        } else {
          visual.root.visible = false;
          visual.note = undefined;
        }
        mapped.delete(id);
      }
      for (const visual of visualPool) {
        if (visual.echoAge === undefined) continue;
        visual.echoAge += deltaSeconds;
        const progress = Math.min(1, visual.echoAge / .09);
        const eased = 1 - (1 - progress) ** 3;
        visual.root.alpha = .22 * (1 - progress) ** 2;
        visual.root.scale.set(1 - eased * .04, 1 - eased * .025);
        visual.root.position.set(visual.echoX ?? 0, (visual.echoY ?? 0) - eased * 5);
        if (progress >= 1) {
          visual.root.visible = false;
          visual.note = undefined;
          visual.echoAge = undefined;
        }
      }
      tileFire.endFrame();
      effects.update(deltaSeconds);
      lastPaintAt = now;

      if (now - hudAt > 70) {
        hudAt = now;
        const progress = Math.max(0, Math.min(1, (timeMs - config.startMs) / ((config.endMs ?? chart.durationMs) - config.startMs)));
        setHud({
          tiles: engine.counts.perfect + engine.counts.great + engine.counts.good,
          streak: engine.combo,
          progress,
          feedback: now < feedbackUntil ? lastFeedback : '',
          countdown: view.countdown,
        });
      }

      if (timeMs >= finishAtMs && !finished) {
        if (config.practice && config.loop) {
          resetEngine();
          void start();
        } else {
          finished = true;
          running = false;
          transport.pause();
          callbacks.current.onFinish(engine.result(true));
        }
      }
      if (transport.context.state === 'suspended' && timeMs > config.startMs) pause();
    };

    let resizeObserver: ResizeObserver | undefined;
    void (async () => {
      try {
        await app.init({
          backgroundAlpha: 0,
          antialias: true,
          resolution: Math.min(window.devicePixelRatio, 2),
          autoDensity: true,
          preference: 'webgl',
          width,
          height,
        });
        if (disposed) {
          app.destroy(true, { children: true });
          return;
        }
        host.current?.appendChild(app.canvas);
        app.canvas.style.touchAction = 'none';
        app.canvas.setAttribute('aria-label', 'Four-lane piano tile stage. Center tiles on the glowing line for maximum points. Early and late visible tiles earn less. Keyboard D F J K.');
        app.stage.addChild(background, laneLightLayer, ribbonLayer, stage, tileFireLayer, effectsLayer);
        resize();
        resizeObserver = new ResizeObserver(resize);
        if (host.current) resizeObserver.observe(host.current);
        app.canvas.addEventListener('pointerdown', down);
        app.canvas.addEventListener('pointermove', move);
        app.canvas.addEventListener('pointerup', up);
        app.canvas.addEventListener('pointercancel', up);
        app.canvas.addEventListener('lostpointercapture', up);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        window.addEventListener('keydown', keyDown);
        window.addEventListener('keyup', keyUp);
        window.addEventListener('blur', blur);
        window.addEventListener('afterbeat:audio-interruption', audioInterrupted);
        document.addEventListener('visibilitychange', hide);
        if (Capacitor.isNativePlatform()) {
          const listener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
            if (!isActive) pause();
          });
          cleanupNative = () => {
            void listener.remove();
          };
        }
        await transport.prepare(song, config.rate, settings.musicVolume, abort.signal);
        if (disposed) return;
        resetEngine();
        if (tutorial) setState('ready');
        else await start();
        app.ticker.add(tick);
      } catch (initializationError) {
        if (disposed) return;
        reportDiagnostic(initializationError, { operation: 'game.initialize' });
        setError('This song could not load. Check device storage or choose another song.');
        setState('error');
      }
    })();

    return () => {
      disposed = true;
      running = false;
      abort.abort();
      app.ticker?.remove(tick);
      if (engine) engine.suspend(engineTime());
      activePointers.clear();
      effects.destroy();
      tileFire.destroy();
      for (const animation of celebration.current?.getAnimations() ?? []) animation.cancel();
      for (const animation of streakValue.current?.getAnimations() ?? []) animation.cancel();
      resizeObserver?.disconnect();
      cleanupNative?.();
      transport.context.removeEventListener('statechange', contextChanged);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('afterbeat:audio-interruption', audioInterrupted);
      document.removeEventListener('visibilitychange', hide);
      void transport.dispose();
      try {
        app.destroy(true, { children: true });
      } catch {
        // Pixi may already be destroyed when React unmounts during initialization.
      }
      for (const gradient of satinFills.values()) gradient.destroy();
      satinFills.clear();
      if (import.meta.env.DEV && devWindow.__afterbeat === devApi) delete devWindow.__afterbeat;
    };
  }, [song.id, chart.id, config, settings]);

  return (
    <section className="game-screen" aria-label="Playing song" ref={screen}>
      <header className="game-header">
        <button className="icon-button" aria-label="Exit song" onClick={onExit}><X size={20} /></button>
        <div>
          <span className="game-track-title">{song.title}</span>
          <span className="game-track-meta">{config.difficulty} · {config.rate}× {config.practice ? '· Practice' : ''}</span>
        </div>
        <button className="icon-button" aria-label="Pause song" disabled={state !== 'playing'} onClick={() => controls.current?.pause()}><Pause size={20} /></button>
      </header>
      <div className="game-progress" role="progressbar" aria-label="Song completion" aria-valuenow={Math.round(hud.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${hud.progress * 100}%` }} /></div>
      <div className="game-hud">
        <div><span className="hud-caption">TILES</span><strong>{hud.tiles}</strong></div>
        <div className="hud-completion"><span className="hud-caption">COMPLETION</span><strong>{Math.round(hud.progress * 100)}<small>%</small></strong></div>
        <div className={`hud-streak combo-tier-${comboVisualState(hud.streak).tier}`}><span className="hud-caption">COMBO</span><strong ref={streakValue}>{hud.streak}</strong><span className="combo-label">{comboVisualState(hud.streak).label}</span><i className="combo-meter"><i style={{ transform: `scaleX(${Math.min(1, hud.streak / 32)})` }} /></i></div>
      </div>
      <div className="game-canvas" ref={host} />
      <div className="combo-aura" aria-hidden="true" />
      <div className="game-feedback" aria-live="off"><span ref={celebration} className={`judgement judgement-${hud.feedback.toLowerCase().replaceAll(' ', '-')}`}>{hud.feedback}</span></div>
      {hud.countdown && state === 'playing' && <div className="game-countdown">{hud.countdown}<small>WATCH THE TILES</small></div>}
      <div className="game-key-hints" aria-hidden="true"><span>D</span><span>F</span><span>J</span><span>K</span></div>
      {state === 'loading' && <div className="game-overlay"><div className="loading-disc"><Volume2 /></div><h2>Setting the stage</h2><p>{config.rate !== 1 ? 'Preparing pitch-preserving audio…' : 'Loading your song…'}</p></div>}
      {state === 'ready' && <div className="game-overlay tutorial-overlay">
        <span className="eyebrow">FOUR LANES · LARGE TILES</span>
        <h2>Feel the beat.</h2>
        <p>The music lands on the glowing line. Tap when the middle of the tile reaches it for maximum points. Early or late visible taps still count, with fewer points.</p>
        <div className="gesture-guide">
          <div><i className="guide-tap" /><strong>Tap</strong><small>Center on the line for full points</small></div>
          <div><i className="guide-hold" /><strong>Hold</strong><small>Hold the whole dog for full points</small></div>
          <div><i className="guide-flick">›</i><strong>Flick</strong><small>Swipe with the arrow</small></div>
          <div><i className="guide-slide" /><strong>Slide</strong><small>Follow the ribbon</small></div>
        </div>
        <p>Use two thumbs. Easy begins with taps; later charts add holds, doubles, flicks, and slides.</p>
        <button className="primary-button" onClick={() => { onTutorialComplete?.(); void controls.current?.restart(); }}>Take the stage</button>
      </div>}
      {state === 'paused' && <div className="game-overlay"><span className="eyebrow">TAKE A BREATH</span><h2>On pause</h2><p>Your concert will resume with a countdown.</p><button className="primary-button" onClick={() => void controls.current?.resume()}><Play size={18} /> Resume</button><button className="secondary-button" onClick={() => void controls.current?.restart()}><RotateCcw size={17} /> Restart song</button><button className="text-button" onClick={onExit}>Back to library</button></div>}
      {state === 'error' && <div className="game-overlay"><h2>Stage unavailable</h2><p role="alert">{error}</p><button className="primary-button" onClick={onExit}>Back to library</button></div>}
    </section>
  );
}
