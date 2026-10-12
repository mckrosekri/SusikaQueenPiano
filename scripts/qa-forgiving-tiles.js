async (page) => {
  await page.goto('http://127.0.0.1:5178');
  await page.setViewportSize({ width: 460, height: 900 });
  await page.getByRole('button', { name: /Carefree artwork Carefree/ }).click();
  await page.getByRole('radio', { name: 'easy', exact: true }).click();
  await page.getByRole('radio', { name: '0.75×', exact: true }).click();
  await page.getByRole('checkbox', { name: /Practice section/ }).check();
  await page.getByLabel('End', { exact: false }).fill('18');
  await page.getByRole('button', { name: 'Start performance' }).click();
  await page.waitForFunction(() => window.__afterbeat?.getStates().length, { timeout: 30000 });
  const tutorial = page.getByRole('button', { name: 'Take the stage' });
  if (await tutorial.isVisible()) await tutorial.click();
  const presses = [], attempted = new Set();
  let screenshotSaved = false;
  for (let cycle = 0; cycle < 2000; cycle++) {
    const state = await page.evaluate(() => {
      const api = window.__afterbeat;
      const canvas = document.querySelector('canvas');
      if (!api || !canvas) return null;
      const box = canvas.getBoundingClientRect();
      return { time: api.transport.sourceTimeAt(), tiles: api.getTileRects(), notes: api.getStates().map(s => ({ id: s.note.id, time: s.note.timeMs })), box: { x: box.x, y: box.y, width: box.width, height: box.height } };
    });
    if (!state) break;
    if (state.time >= 0) {
      for (const tile of state.tiles.filter(t => t.status === 'pending')) {
        if (attempted.has(tile.id)) continue;
        const order = state.notes.findIndex(n => n.id === tile.id);
        const threshold = [0.18, 0.55, 0.99][order % 3];
        const centerY = (tile.top + tile.bottom) / 2;
        if (centerY < state.box.height * threshold) continue;
        const y = Math.max(2, Math.min(state.box.height - 2, centerY));
        if (y < tile.top || y > tile.bottom) continue;
        if (!screenshotSaved && state.time > 3000) { await page.screenshot({ path: 'output/playwright/forgiving-tiles-gameplay.png' }); screenshotSaved = true; }
        await page.mouse.click(state.box.x + (tile.left + tile.right) / 2, state.box.y + y);
        attempted.add(tile.id);
        const note = state.notes.find(n => n.id === tile.id);
        presses.push({ id: tile.id, wallOffsetFromOnsetMs: (state.time - note.time) / 0.75, screenFraction: y / state.box.height });
      }
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  await page.getByRole('button', { name: 'Choose song', exact: true }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: 'output/playwright/forgiving-tiles-results.png' });
  const result = await page.evaluate(() => JSON.parse(localStorage.getItem('afterbeat.progress.v1')).results.at(-1));
  if (result.counts.miss || result.accuracy !== 100) throw new Error('Visible tile input failed: ' + JSON.stringify(result));
  if (!presses.some(p => p.wallOffsetFromOnsetMs < -500) || !presses.some(p => p.wallOffsetFromOnsetMs > 150)) throw new Error('Broad early and late input were not exercised');
  return { input: 'Real headless Chrome mouse events at upper, middle and bottom tile positions', presses, result, passed: true };
}
