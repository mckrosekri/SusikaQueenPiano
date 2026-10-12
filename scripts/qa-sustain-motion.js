async (page) => {

  await page.goto('http://127.0.0.1:5178');
  const view = page.viewportSize();
  await page.setViewportSize(view.width === 1440 ? view : { width: 430, height: 932 });
  const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const suffix = reduced ? 'reduced-' : '';
  await page.getByRole('button', { name: /Carefree artwork Carefree/ }).click();
  await page.getByRole('radio', { name: 'expert', exact: true }).click();
  await page.getByRole('radio', { name: '0.75×', exact: true }).click();
  await page.getByRole('checkbox', { name: /Practice section/ }).check();
  await page.getByLabel('End', { exact: false }).fill('36');
  await page.getByRole('button', { name: 'Start performance' }).click();
  await page.waitForFunction(() => window.__afterbeat?.getStates().length, { timeout: 30000 });
  const tutorial = page.getByRole('button', { name: 'Take the stage' });
  if (await tutorial.isVisible()) await tutorial.click();
  const reports = [];
  for (const kind of ['hold', 'slide']) {
    await page.waitForFunction(kind => {
      const api = window.__afterbeat, h = document.querySelector('canvas').getBoundingClientRect().height;
      return api.transport.sourceTimeAt() >= 0 && api.getTileRects().some(t => t.kind === kind && t.status === 'pending'
        && t.bottom > h * .65 && t.bottom < h * .87 && t.bottom - t.top > 150);
    }, kind, { timeout: 50000 });
    const picked = await page.evaluate(kind => {
      const api = window.__afterbeat, canvas = document.querySelector('canvas'), b = canvas.getBoundingClientRect();
      const tile = api.getTileRects().find(t => t.kind === kind && t.status === 'pending' && t.bottom > b.height * .65 && t.bottom < b.height * .87 && t.bottom - t.top > 150);
      return { tile, note: api.getStates().find(s => s.note.id === tile.id).note, box: { x: b.x, y: b.y, width: b.width, height: b.height } };
    }, kind);
    const y = picked.box.y + Math.min(picked.box.height * .7, picked.tile.bottom - 12);
    await page.mouse.move(picked.box.x + (picked.tile.left + picked.tile.right) / 2, y);
    await page.screenshot({ path: `output/playwright/${kind}-motion-${suffix}before.png` });
    await page.mouse.down();
    const samples = [];
    let savedMid = false, savedLate = false, frozen = false, regrabbed = false, paused = false;
    for (let frame = 0; frame < 400; frame++) {
      const state = await page.evaluate(id => {
        const api = window.__afterbeat, n = api.getStates().find(s => s.note.id === id);
        const time = api.transport.sourceTimeAt();
        let lane = n.note.lane;
        const path = n.note.path;
        if (path?.length) {
          lane = path.at(-1).lane;
          if (time <= path[0].timeMs) lane = path[0].lane;
          else for (let i = 1; i < path.length; i++) if (time <= path[i].timeMs) {
            const a = path[i-1], b = path[i]; lane = a.lane + (b.lane-a.lane) * (time-a.timeMs)/(b.timeMs-a.timeMs); break;
          }
        }
        return { time, lane, status: n.status, judgement: n.judgement, scoring: { pointer: n.pointer, lastLane: n.lastLane, coverageMs: n.coverageMs, sampledMs: n.sampledMs, releasedAt: n.releasedAt, releaseExpired: n.releaseExpired }, effect: api.getSustainEffects().find(e => e.id === id), metrics: api.getEffectMetrics() };
      }, picked.note.id);
      if (!state.effect) {
        if (state.status !== 'done' || state.judgement === 'miss') throw Error(`${kind} did not finish successfully: ` + JSON.stringify({state,samples}));
        reports.push({ kind, note: picked.note, samples, completed: state });
        break;
      }
      samples.push(state);
      await page.mouse.move(picked.box.x + (state.lane + .5) * picked.box.width / 4, y);
      if (kind === 'hold' && state.effect.consumed > .12 && !frozen) {
        await page.mouse.move(picked.box.x + ((state.lane + 2) % 4 + .5) * picked.box.width / 4, y);
        await page.waitForTimeout(40);
        const a = await page.evaluate(id => ({ effect: window.__afterbeat.getSustainEffects().find(e => e.id === id), metrics: window.__afterbeat.getEffectMetrics() }), picked.note.id);
        await page.waitForTimeout(70);
        const b = await page.evaluate(id => ({ effect: window.__afterbeat.getSustainEffects().find(e => e.id === id), metrics: window.__afterbeat.getEffectMetrics() }), picked.note.id);
        if (a.effect.consumed !== b.effect.consumed || a.metrics.emittedStars !== b.metrics.emittedStars) throw Error('Wrong-lane consumption did not freeze');
        frozen = true;
        await page.mouse.move(picked.box.x + (state.lane + .5) * picked.box.width / 4, y);
      }
      if (kind === 'hold' && state.effect.consumed > .25 && !regrabbed) {
        await page.mouse.up();
        await page.waitForTimeout(60);
        await page.mouse.down();
        regrabbed = true;
      }
      if (!savedMid && state.effect.consumed > .4) { await page.screenshot({ path: `output/playwright/${kind}-motion-${suffix}mid.png` }); savedMid = true; }
      if (kind === 'hold' && state.effect.consumed > .5 && !paused) {
        await page.keyboard.press('Escape');
        await page.mouse.up();
        const before = await page.evaluate(id => window.__afterbeat.getSustainEffects().find(e => e.id === id), picked.note.id);
        await page.waitForTimeout(200);
        const after = await page.evaluate(id => window.__afterbeat.getSustainEffects().find(e => e.id === id), picked.note.id);
        if (before.consumed !== after.consumed) throw Error('Pause did not freeze consumption');
        const stoppedAt = await page.evaluate(() => window.__afterbeat.transport.sourceTimeAt());
        await page.getByRole('button', { name: 'Resume', exact: true }).click();
        await page.getByRole('button', { name: 'Resume', exact: true }).waitFor({ state: 'hidden' });
        await page.waitForFunction(time => window.__afterbeat.transport.sourceTimeAt() >= time, stoppedAt);
        await page.mouse.move(picked.box.x + (state.lane + .5) * picked.box.width / 4, y);
        await page.mouse.down();
        paused = true;
      }
      if (!savedLate && state.effect.consumed > .78) { await page.screenshot({ path: `output/playwright/${kind}-motion-${suffix}late.png` }); savedLate = true; }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    await page.mouse.up();
    if (!reports.some(r => r.kind === kind)) throw Error(`${kind} never captured`);
    const heights = samples.map(s => s.effect.height);
    if (!heights.every((height, i) => i === 0 || height <= heights[i-1] + .001)) throw Error('Remaining height grew');
    if (reduced ? samples.some(s => s.metrics.emittedStars > 0) : !samples.some(s => s.metrics.emittedStars > samples[0].metrics.emittedStars)) throw Error('Star emission disagrees with motion preference');
    await page.screenshot({ path: `output/playwright/${kind}-motion-${suffix}complete.png` });
  }
  await page.getByRole('button', { name: 'Pause song' }).click();
  const proof = { passed: true, input: 'Real Chrome mouse down/move/up, hardware pointer capture enabled', reports };
  return proof;
}
