async page => {
  const checks = [];
  for (const mode of ['held', 'tapped']) {
    await page.goto('http://127.0.0.1:5178/');
    // Only this isolated QA profile is changed; the owner's stored settings stay intact.
    await page.evaluate(() => {
      const value = JSON.parse(localStorage.getItem('afterbeat.progress.v1') ?? '{}');
      value.version = 1;
      value.settings = { ...value.settings, calibrationMs: 250 };
      localStorage.setItem('afterbeat.progress.v1', JSON.stringify(value));
    });
    await page.reload();
    await page.setViewportSize(mode === 'held' ? { width: 430, height: 932 } : { width: 1280, height: 900 });
    await page.getByRole('button', { name: /Carefree artwork Carefree/ }).click();
    await page.getByRole('radio', { name: 'expert', exact: true }).click();
    await page.getByRole('radio', { name: '0.75×', exact: true }).click();
    const practice = page.getByRole('checkbox', { name: /Practice section/ });
    if (!(await practice.isChecked())) await practice.check();
    await page.getByLabel('Start', { exact: false }).fill('0');
    await page.getByLabel('End', { exact: false }).fill('12');
    await page.getByRole('button', { name: 'Start performance' }).click();
    await page.waitForFunction(() => window.__afterbeat?.getStates().length);
    const tutorial = page.getByRole('button', { name: 'Take the stage' });
    if (await tutorial.isVisible()) await tutorial.click();
    await page.waitForFunction(() => window.__afterbeat?.transport.sourceTimeAt() > 0);
    const note = await page.evaluate(() => window.__afterbeat.chart.notes.find(n => n.kind === 'hold' && n.timeMs > 800 && n.endTimeMs < 10_000));
    if (!note) throw Error('No suitable dog in practice section');
    await page.waitForFunction(({ id, mode }) => {
      const api = window.__afterbeat;
      const note = api.chart.notes.find(n => n.id === id);
      const time = api.transport.sourceTimeAt() - 250 * .75;
      return time >= note.timeMs - (mode === 'tapped' ? -10 : 180) && api.getTileRects().some(t => t.id === id);
    }, { id: note.id, mode });
    const point = await page.evaluate(id => {
      const tile = window.__afterbeat.getTileRects().find(t => t.id === id);
      const box = document.querySelector('canvas').getBoundingClientRect();
      return { x: box.x + (tile.left + tile.right) / 2, y: box.y + (Math.max(0, tile.top) + Math.min(box.height, tile.bottom)) / 2 };
    }, note.id);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForFunction(id => window.__afterbeat.getStates().some(s => s.note.id === id && s.status === 'active'), note.id);
    if (mode === 'tapped') {
      await page.waitForTimeout(50);
      await page.mouse.up();
    } else {
      await page.waitForFunction(id => {
        const api = window.__afterbeat;
        return api.transport.sourceTimeAt() - 250 * .75 >= api.chart.notes.find(n => n.id === id).timeMs + 100;
      }, note.id);
      await page.screenshot({ path: 'output/playwright/hold-credit-dog.png' });
    }
    await page.waitForFunction(id => window.__afterbeat.getStates().some(s => s.note.id === id && s.status === 'done'), note.id);
    if (mode === 'held') await page.mouse.up();
    const proof = await page.evaluate(id => {
      const api = window.__afterbeat, s = api.getStates().find(s => s.note.id === id);
      return { noteId: id, durationMs: s.note.endTimeMs - s.note.timeMs, heldMs: s.coverageMs,
        credit: s.coverageMs / (s.note.endTimeMs - s.note.timeMs), judgement: s.judgement,
        score: api.getEngine().score, scoringVersion: api.getEngine().result(false).chartId };
    }, note.id);
    if (mode === 'held' && proof.credit < .98) throw Error(`Full dog did not earn full duration: ${JSON.stringify(proof)}`);
    if (mode === 'tapped' && proof.credit > .2) throw Error(`Tap earned too much dog credit: ${JSON.stringify(proof)}`);
    checks.push({ mode, ...proof });
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 30_000 });
    await page.getByText('Points earned', { exact: true }).waitFor();
    await page.screenshot({ path: `output/playwright/hold-credit-${mode}-results.png` });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Results overflow');
  }
  return { passed: true, input: 'Real headless Chrome mouse through game handlers', checks };
}
