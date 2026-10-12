async (page) => {
  const report = {
    environment: 'Isolated headless Chrome, 430x932 viewport, real Playwright mouse input',
    config: { song: 'Cipher', difficulty: 'expert', rate: 0.75, practiceStartMs: 0, practiceEndMs: 36_000 },
    checks: [],
  };
  let phase = 'setup';
  const assert = (condition, message, details) => {
    if (!condition) throw new Error(`${message}${details ? `: ${JSON.stringify(details)}` : ''}`);
  };
  const apiState = async () => page.evaluate(() => {
    const api = window.__afterbeat;
    const canvas = document.querySelector('canvas');
    if (!api || !canvas) return undefined;
    const box = canvas.getBoundingClientRect();
    return {
      timeMs: api.transport.sourceTimeAt(),
      states: api.getStates().map((state) => ({ note: state.note, status: state.status, pointer: state.pointer })),
      tiles: api.getTileRects(),
      effects: api.getSustainEffects(),
      metrics: api.getEffectMetrics(),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  });
  const effectFor = async (id) => (await apiState())?.effects.find((effect) => effect.id === id);
  const stateFor = async (id) => (await apiState())?.states.find((state) => state.note.id === id);
  const waitForSource = async (timeMs) => page.waitForFunction(
    (target) => window.__afterbeat?.transport.sourceTimeAt() >= target,
    timeMs,
    { timeout: 60_000 },
  );
  const waitForEffectFraction = async (id, fraction) => page.waitForFunction(
    ({ noteId, target }) => window.__afterbeat?.getSustainEffects().some(
      (effect) => effect.id === noteId && effect.consumed >= target,
    ),
    { noteId: id, target: fraction },
    { timeout: 10_000 },
  );
  const expectedLane = (note, timeMs) => {
    if (!note.path?.length || timeMs <= note.path[0].timeMs) return note.path?.[0]?.lane ?? note.lane;
    for (let index = 1; index < note.path.length; index += 1) {
      const previous = note.path[index - 1];
      const next = note.path[index];
      if (timeMs <= next.timeMs) {
        return previous.lane + (next.lane - previous.lane)
          * (timeMs - previous.timeMs) / Math.max(1, next.timeMs - previous.timeMs);
      }
    }
    return note.path.at(-1)?.lane ?? note.lane;
  };
  const canvasPoint = (state, lane, yFraction) => ({
    x: state.box.x + (lane + 0.5) * state.box.width / 4,
    y: state.box.y + yFraction * state.box.height,
  });
  const capture = async (note) => {
    phase = `capture-${note.kind}-${note.timeMs}`;
    await waitForSource(note.timeMs - 90);
    await page.waitForFunction(
      (id) => window.__afterbeat?.getTileRects().some((tile) => tile.id === id && tile.status === 'pending'),
      note.id,
      { timeout: 10_000 },
    );
    const state = await apiState();
    const tile = state.tiles.find((candidate) => candidate.id === note.id);
    assert(tile, 'Target sustain did not render', { id: note.id, timeMs: state.timeMs });
    const point = {
      x: state.box.x + (tile.left + tile.right) / 2,
      y: state.box.y + Math.max(4, Math.min(state.box.height - 4, (Math.max(0, tile.top) + Math.min(state.box.height, tile.bottom)) / 2)),
    };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForFunction(
      (id) => window.__afterbeat?.getSustainEffects().some((effect) => effect.id === id && effect.connected),
      note.id,
      { timeout: 2_000 },
    );
  };
  const waitForDone = async (note) => {
    await page.waitForFunction(
      (id) => window.__afterbeat?.getStates().some((state) => state.note.id === id && state.status === 'done'),
      note.id,
      { timeout: 10_000 },
    );
    const state = await apiState();
    assert(!state.effects.some((effect) => effect.id === note.id), 'Completed sustain effect was not removed', state.effects);
  };

  await page.goto('http://127.0.0.1:5178');
  await page.setViewportSize({ width: 430, height: 932 });
  await page.getByRole('button', { name: /Cipher artwork Cipher/ }).click();
  await page.getByRole('radio', { name: 'expert', exact: true }).click();
  await page.getByRole('radio', { name: '0.75×', exact: true }).click();
  const practice = page.getByRole('checkbox', { name: /Practice section/ });
  if (!(await practice.isChecked())) await practice.check();
  await page.getByLabel('Start', { exact: false }).fill('0');
  await page.getByLabel('End', { exact: false }).fill('36');
  await page.getByRole('button', { name: 'Start performance' }).click();
  await page.waitForFunction(() => window.__afterbeat?.getStates().length, { timeout: 30_000 });
  const tutorial = page.getByRole('button', { name: 'Take the stage' });
  if (await tutorial.isVisible()) await tutorial.click();

  const notes = (await apiState()).states
    .map((state) => state.note)
    .filter((note) => (note.kind === 'hold' || note.kind === 'slide')
      && note.endTimeMs <= 35_500
      && note.endTimeMs - note.timeMs >= 800);
  const pairs = [];
  for (const hold of notes.filter((note) => note.kind === 'hold')) {
    for (const slide of notes.filter((note) => note.kind === 'slide')) {
      const ordered = [hold, slide].sort((left, right) => left.timeMs - right.timeMs);
      if (ordered[1].timeMs >= ordered[0].endTimeMs + 350) pairs.push({ hold, slide, finish: ordered[1].endTimeMs });
    }
  }
  pairs.sort((left, right) => {
    const durationDifference = (right.hold.endTimeMs - right.hold.timeMs)
      - (left.hold.endTimeMs - left.hold.timeMs);
    return durationDifference || left.finish - right.finish;
  });
  const selected = pairs[0];
  assert(selected, 'No separated Cipher Expert hold/slide pair was available', notes);
  const selectedInOrder = [selected.hold, selected.slide].sort((left, right) => left.timeMs - right.timeMs);
  report.notes = selectedInOrder.map((note) => ({
    id: note.id,
    kind: note.kind,
    lane: note.lane,
    timeMs: note.timeMs,
    endTimeMs: note.endTimeMs,
    durationMs: note.endTimeMs - note.timeMs,
  }));

  const verifyHold = async (note) => {
    await capture(note);
    const starsAtCapture = (await apiState()).metrics.emittedStars;
    await waitForEffectFraction(note.id, 0.2);
    const mid = await effectFor(note.id);
    assert(mid.consumed >= 0.2 && mid.height < mid.originalHeight, 'Hold did not consume from authored time', mid);
    assert((await apiState()).metrics.emittedStars > starsAtCapture, 'Valid held input emitted no shooting stars');
    await page.screenshot({ path: 'output/playwright/streaming-hold-mid.png' });

    const beforeFingerMove = await effectFor(note.id);
    const state = await apiState();
    const highPoint = canvasPoint(state, note.lane, 0.18);
    await page.mouse.move(highPoint.x, highPoint.y);
    await page.waitForTimeout(35);
    const afterFingerMove = await effectFor(note.id);
    assert(afterFingerMove, 'Hold completed before pointer-height geometry could be sampled', { note, beforeFingerMove });
    assert(Math.abs(afterFingerMove.y - state.box.height * 0.18) < 3, 'Real pointer Y was not observed', afterFingerMove);
    assert(Math.abs(afterFingerMove.bottom - beforeFingerMove.bottom) < 1,
      'Finger Y re-anchored the canonical sustain body', { beforeFingerMove, afterFingerMove });

    const offLane = canvasPoint(state, note.lane < 2 ? 3.35 : -0.35, 0.5);
    phase = 'hold-off-lane';
    await page.mouse.move(offLane.x, offLane.y);
    await page.waitForFunction(
      (id) => window.__afterbeat?.getSustainEffects().some((effect) => effect.id === id && !effect.following),
      note.id,
      { timeout: 2_000 },
    );
    await page.waitForTimeout(70);
    const offStart = await effectFor(note.id);
    const offStars = (await apiState()).metrics.emittedStars;
    await waitForEffectFraction(note.id, Math.min(0.82, offStart.consumed + 0.08));
    const offEnd = await effectFor(note.id);
    const offStarsAfter = (await apiState()).metrics.emittedStars;
    assert(offEnd.consumed > offStart.consumed && offEnd.height < offStart.height,
      'Off-lane tail stopped streaming', { offStart, offEnd });
    assert(offStarsAfter === offStars, 'Off-lane input continued emitting stars', { offStars, offStarsAfter });
    await page.screenshot({ path: 'output/playwright/streaming-hold-offlane.png' });

    const backState = await apiState();
    phase = 'hold-back-on-lane';
    const validPoint = canvasPoint(backState, note.lane, 0.55);
    await page.mouse.move(validPoint.x, validPoint.y);
    await page.waitForFunction(
      (id) => window.__afterbeat?.getSustainEffects().some((effect) => effect.id === id && effect.following),
      note.id,
      { timeout: 2_000 },
    );
    const beforeRelease = await effectFor(note.id);
    phase = 'hold-regrab';
    await page.mouse.up();
    await page.waitForTimeout(35);
    const released = await effectFor(note.id);
    const regrabState = await apiState();
    const regrabTile = regrabState.tiles.find((tile) => tile.id === note.id);
    assert(regrabTile, 'Released sustain was unavailable for re-grab', regrabState.tiles);
    await page.mouse.move(
      regrabState.box.x + (regrabTile.left + regrabTile.right) / 2,
      regrabState.box.y + (regrabTile.top + regrabTile.bottom) / 2,
    );
    await page.mouse.down();
    await page.waitForFunction(
      (id) => window.__afterbeat?.getSustainEffects().some((effect) => effect.id === id && effect.connected),
      note.id,
      { timeout: 2_000 },
    );
    const regrabbed = await effectFor(note.id);
    assert(regrabbed.consumed >= released.consumed && regrabbed.height <= released.height,
      'Re-grab regrew the consumed sustain', { beforeRelease, released, regrabbed });

    await page.mouse.up();
    await page.getByRole('button', { name: 'Pause song' }).click();
    const paused = await effectFor(note.id);
    await page.waitForTimeout(650);
    const pausedLater = await effectFor(note.id);
    assert(pausedLater && Math.abs(pausedLater.consumed - paused.consumed) < 0.0001
      && Math.abs(pausedLater.height - paused.height) < 0.01,
    'Paused sustain continued consuming', { paused, pausedLater });
    await page.screenshot({ path: 'output/playwright/streaming-hold-paused.png' });

    await page.getByRole('button', { name: /Resume/ }).click();
    phase = 'hold-resume';
    await page.getByRole('button', { name: /Resume/ }).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('.game-countdown'));
    await waitForSource(paused.captureTimeMs > note.timeMs ? paused.captureTimeMs : note.timeMs + paused.consumed * (note.endTimeMs - note.timeMs));
    await page.waitForFunction(
      (id) => window.__afterbeat?.getTileRects().some((tile) => tile.id === id),
      note.id,
      { timeout: 3_000 },
    );
    const resumeState = await apiState();
    const resumeTile = resumeState.tiles.find((tile) => tile.id === note.id);
    assert(resumeTile, 'Paused sustain was unavailable after countdown', resumeState.tiles);
    await page.mouse.move(
      resumeState.box.x + (resumeTile.left + resumeTile.right) / 2,
      resumeState.box.y + (resumeTile.top + resumeTile.bottom) / 2,
    );
    await page.mouse.down();
    await page.waitForFunction(
      (id) => window.__afterbeat?.getSustainEffects().some((effect) => effect.id === id && effect.connected),
      note.id,
      { timeout: 2_000 },
    );
    const resumed = await effectFor(note.id);
    assert(resumed.consumed + 0.02 >= paused.consumed && resumed.height <= paused.height + 2,
      'Resume/re-grab visibly regrew the sustain', { paused, resumed });
    await waitForDone(note);
    await page.mouse.up();
    report.checks.push({
      kind: 'hold',
      authoredStreaming: true,
      pointerYIndependent: true,
      offLaneTailContinued: true,
      offLaneStarsStopped: true,
      regrabMonotonic: true,
      pauseFrozen: true,
      completed: true,
      samples: { mid, beforeFingerMove, afterFingerMove, offStart, offEnd, released, regrabbed, paused, resumed },
    });
  };

  const verifySlide = async (note) => {
    await capture(note);
    const samples = [];
    const starsBefore = (await apiState()).metrics.emittedStars;
    let midSaved = false;
    let lateSaved = false;
    let previousConsumed = 0;
    while (true) {
      const state = await apiState();
      const noteState = state.states.find((candidate) => candidate.note.id === note.id);
      if (noteState?.status === 'done') break;
      const effect = state.effects.find((candidate) => candidate.id === note.id);
      assert(effect, 'Slide effect disappeared before completion', { timeMs: state.timeMs, noteState });
      assert(effect.consumed + 0.0001 >= previousConsumed, 'Slide tail regrew', { previousConsumed, effect });
      previousConsumed = effect.consumed;
      samples.push({ timeMs: state.timeMs, consumed: effect.consumed, height: effect.height, bottom: effect.bottom });
      const lane = expectedLane(note, state.timeMs);
      const point = canvasPoint(state, lane, effect.consumed > 0.32 && effect.consumed < 0.48 ? 0.2 : 0.58);
      await page.mouse.move(point.x, point.y);
      if (!midSaved && effect.consumed >= 0.28) {
        await page.screenshot({ path: 'output/playwright/streaming-slide-mid.png' });
        midSaved = true;
      }
      if (!lateSaved && effect.consumed >= 0.7) {
        await page.screenshot({ path: 'output/playwright/streaming-slide-late.png' });
        lateSaved = true;
      }
      await page.waitForTimeout(24);
    }
    await page.mouse.up();
    const starsAfter = (await apiState()).metrics.emittedStars;
    const bottoms = samples.filter((sample) => sample.consumed >= 0.1).map((sample) => sample.bottom);
    assert(samples.length >= 8 && midSaved && lateSaved, 'Slide did not provide enough visual samples', samples);
    assert(starsAfter > starsBefore, 'Valid slide input emitted no shooting stars', { starsBefore, starsAfter });
    assert(Math.max(...bottoms) - Math.min(...bottoms) < 1.5,
      'Slide pointer movement re-anchored the canonical body', bottoms);
    assert(!((await apiState()).effects.some((effect) => effect.id === note.id)), 'Completed slide effect remained visible');
    report.checks.push({
      kind: 'slide',
      authoredStreaming: true,
      monotonicSamples: samples.length,
      pointerYIndependent: true,
      shootingStars: starsAfter - starsBefore,
      completed: true,
      first: samples[0],
      last: samples.at(-1),
    });
  };

  for (const note of selectedInOrder) {
    try {
      if (note.kind === 'hold') await verifyHold(note);
      else await verifySlide(note);
    } catch (error) {
      const state = await apiState();
      throw new Error(`${phase}: ${error.message}; ${JSON.stringify({ note, timeMs: state?.timeMs, effect: state?.effects.find(e=>e.id===note.id), scoring: state?.states.find(s=>s.note.id===note.id), checks: report.checks })}`);
    }
  }

  report.effectMetrics = (await apiState()).metrics;
  report.passed = true;
  return report;
}

