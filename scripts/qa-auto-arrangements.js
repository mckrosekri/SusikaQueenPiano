async page => {
  await page.goto('http://127.0.0.1:5178/');
  const selection = await page.evaluate(async () => {
    const { generateCharts } = await import('/src/rhythm/chart.ts');
    const { BUNDLED_SONGS } = await import('/src/data/catalog.ts');
    const rows = [];
    let selected;
    for (const song of BUNDLED_SONGS) {
      const analysis = await fetch(`/charts/${song.id}.json`).then(response => response.json());
      const charts = generateCharts(analysis);
      rows.push({ title: song.title, counts: Object.values(charts).map(chart => chart.notes.length),
        tapShares: Object.values(charts).map(chart => chart.notes.filter(note => note.kind === 'tap').length / chart.notes.length) });
      const notes = charts.expert.notes;
      for (const note of notes.filter(note => note.kind === 'slide')) {
        const startMs = Math.max(0, Math.floor((note.timeMs - 1_000) / 1_000) * 1_000);
        const endMs = Math.min(charts.expert.durationMs, startMs + 30_000);
        const window = notes.filter(note => note.timeMs >= startMs && note.timeMs < endMs);
        const kinds = new Set(window.map(note => note.kind));
        if (kinds.size === 4 && (!selected || window.length > selected.notes)) {
          selected = { title: song.title, startMs, endMs, notes: window.length };
        }
      }
    }
    if (!selected) throw Error('No demo section exercises all four gestures');
    return { rows, selected };
  });
  const runs = [];
  for (const scenario of [
    { title: 'Carefree', difficulty: 'normal', rate: 1, startMs: 0, endMs: 24_000, width: 430, height: 932 },
    { ...selection.selected, difficulty: 'expert', rate: 1.5, width: 1280, height: 900 },
  ]) {
    await page.goto('http://127.0.0.1:5178/');
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.getByRole('button', { name: new RegExp(`${scenario.title} artwork ${scenario.title}`) }).click();
    await page.getByRole('radio', { name: scenario.difficulty, exact: true }).click();
    await page.getByRole('radio', { name: `${scenario.rate}×`, exact: true }).click();
    const practice = page.getByRole('checkbox', { name: /Practice section/ });
    if (!(await practice.isChecked())) await practice.check();
    await page.getByLabel('Start', { exact: false }).fill(String(scenario.startMs / 1_000));
    await page.getByLabel('End', { exact: false }).fill(String(scenario.endMs / 1_000));
    await page.getByRole('button', { name: 'Start performance' }).click();
    await page.waitForFunction(() => window.__afterbeat?.getStates().length);
    const tutorial = page.getByRole('button', { name: 'Take the stage' });
    if (await tutorial.isVisible()) await tutorial.click();
    await page.evaluate(() => {
      const api = window.__afterbeat, canvas = document.querySelector('canvas'), box = canvas.getBoundingClientRect();
      canvas.setPointerCapture = () => {}; // Synthetic IDs only; handlers and transport stay real.
      const actions = [], free = [-Infinity, -Infinity], active = new Map();
      const notes = api.getStates().map(state => state.note);
      for (const note of notes) {
        const begin = note.timeMs - (note.endTimeMs ? 60 : 0);
        const finger = free.findIndex(end => end <= begin);
        if (finger < 0) throw Error('Chart requires a third finger');
        const end = note.endTimeMs ?? note.timeMs + 32 * api.config.rate;
        free[finger] = end;
        actions.push({ time: begin, type: 'pointerdown', finger, note });
        if (note.kind === 'flick') actions.push({ time: note.timeMs + 16 * api.config.rate, type: 'pointermove', finger, note });
        actions.push({ time: end, type: 'pointerup', finger, note });
      }
      actions.sort((a, b) => a.time - b.time || (a.type === 'pointerup' ? -1 : b.type === 'pointerup' ? 1 : 0));
      const proof = window.__autoProof = { chartId: api.chart.id, total: notes.length, kinds: Object.fromEntries(
        ['tap', 'hold', 'slide', 'flick'].map(kind => [kind, notes.filter(note => note.kind === kind).length])),
        actions: 0, missingTargets: [], maxVisibleOverlapPx: 0 };
      const laneAt = (note, time) => {
        if (!note.path?.length || time <= note.path[0].timeMs) return note.lane;
        for (let i = 1; i < note.path.length; i++) {
          const a = note.path[i - 1], b = note.path[i];
          if (time <= b.timeMs) return a.lane + (b.lane - a.lane) * (time - a.timeMs) / (b.timeMs - a.timeMs);
        }
        return note.targetLane;
      };
      const dispatch = (type, finger, lane, y) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 100 + finger, pointerType: 'touch', isPrimary: finger === 0,
        clientX: box.x + (lane + .5) * box.width / 4, clientY: box.y + y,
        buttons: type === 'pointerup' ? 0 : 1, pressure: .5,
      }));
      let index = 0;
      const step = () => {
        const time = api.transport.sourceTimeAt(), rects = api.getTileRects();
        for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
          const x = Math.min(rects[a].right, rects[b].right) - Math.max(rects[a].left, rects[b].left);
          const y = Math.min(box.height, rects[a].bottom, rects[b].bottom) - Math.max(0, rects[a].top, rects[b].top);
          if (x > 1 && y > 1) proof.maxVisibleOverlapPx = Math.max(proof.maxVisibleOverlapPx, y);
        }
        for (const [finger, note] of active) if (note.kind === 'slide') dispatch('pointermove', finger, laneAt(note, time), box.height * .7);
        while (index < actions.length && actions[index].time <= time) {
          const action = actions[index++], note = action.note;
          const tile = action.type === 'pointerdown' ? rects.find(tile => tile.id === note.id) : undefined;
          if (action.type === 'pointerdown' && !tile) proof.missingTargets.push(note.id);
          const lane = action.type === 'pointermove' ? note.lane + note.direction * .45 : action.type === 'pointerdown' ? note.lane : laneAt(note, time);
          const y = tile ? Math.max(2, Math.min(box.height - 2, (Math.max(0, tile.top) + Math.min(box.height, tile.bottom)) / 2)) : box.height * .7;
          dispatch(action.type, action.finger, lane, y);
          if (action.type === 'pointerdown') active.set(action.finger, note);
          if (action.type === 'pointerup') active.delete(action.finger);
          proof.actions++;
        }
        if (index < actions.length || api.getStates().some(state => state.status !== 'done')) requestAnimationFrame(step);
        else proof.complete = { counts: api.getEngine().counts, performance: api.getPerformance(), audio: api.getMetrics() };
      };
      requestAnimationFrame(step);
    });
    await page.waitForFunction(time => window.__afterbeat.transport.sourceTimeAt() > time,
      scenario.startMs + 5_000);
    await page.screenshot({ path: `output/playwright/auto-v4-${scenario.difficulty}-play.png` });
    await page.getByRole('button', { name: 'Choose song', exact: true }).waitFor({ timeout: 45_000 });
    await page.screenshot({ path: `output/playwright/auto-v4-${scenario.difficulty}-results.png` });
    const proof = await page.evaluate(() => window.__autoProof);
    const result = await page.evaluate(() => JSON.parse(localStorage.getItem('afterbeat.progress.v1')).results.at(-1));
    if (proof.maxVisibleOverlapPx > 1 || proof.missingTargets.length || result.counts.miss || result.accuracy < 99) {
      throw Error(JSON.stringify({ scenario, proof, result }));
    }
    runs.push({ scenario, proof, result });
  }
  return { passed: true, input: 'Synthetic two-pointer browser handlers, hardware capture bypass only', selection, runs };
}
