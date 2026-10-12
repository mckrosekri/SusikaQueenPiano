async page => {
  const title = 'QA Original Piano';
  const audioRequests = [];
  const observe = request => {
    const bytes = request.postDataBuffer()?.byteLength ?? 0;
    if (request.method() !== 'GET' && bytes > 100000) audioRequests.push({ method: request.method(), path: new URL(request.url()).pathname, bytes });
  };
  page.on('request', observe);
  const savedSongs = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('afterbeat-library', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, get = db.transaction('songs').objectStore('songs').getAll(); get.onsuccess = () => { resolve(get.result.map(song => ({ id: song.id, title: song.title, version: song.analysis.version, notes: Object.fromEntries(Object.entries(song.charts).map(([key, chart]) => [key, chart.notes.length])) }))); db.close(); }; get.onerror = () => reject(get.error); };
  }));
  await page.getByRole('button', { name: 'Import a song' }).waitFor();
  const before = await savedSongs();
  await page.locator('input[type=file]').setInputFiles('output/playwright/QA Original Piano.wav');
  await page.getByRole('heading', { name: title, exact: true }).waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: 'Start performance' }).waitFor();
  const imported = (await savedSongs()).find(song => song.title === title);
  if (!imported || !imported.version.startsWith('afterbeat-analysis-v2')) throw Error('Current analysis was not persisted');
  await page.getByRole('button', { name: 'Add to favorites', exact: true }).click();
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'Favorites', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(title + ' artwork ' + title) }).waitFor();
  await page.screenshot({ path: 'output/base44/import-favorite-persisted.png' });
  await page.getByRole('tab', { name: 'On this device', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles('output/playwright/QA Original Piano.wav');
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  const afterDuplicate = await savedSongs();
  if (afterDuplicate.length !== before.length + 1 || afterDuplicate.filter(song => song.id === imported.id).length !== 1) throw Error('Duplicate import created another row');
  const runs = [];
  for (const difficulty of ['easy', 'normal', 'hard', 'expert']) {
    await page.getByRole('radio', { name: difficulty, exact: true }).click();
    await page.getByRole('radio', { name: '1×', exact: true }).click();
    await page.getByRole('button', { name: 'Start performance' }).click();
    await page.waitForFunction(() => window.__afterbeat?.getStates().length);
    const tutorial = page.getByRole('button', { name: 'Take the stage' });
    if (await tutorial.isVisible()) await tutorial.click();
    const metrics = await page.evaluate(async () => {
      const api = window.__afterbeat, canvas = document.querySelector('canvas'), box = canvas.getBoundingClientRect();
      const originalCapture = canvas.setPointerCapture;
      canvas.setPointerCapture = () => {};
      const actions = [], available = [-1, -1], rate = api.config.rate;
      for (const note of api.getStates().map(state => state.note)) {
        const finger = available.findIndex(end => end <= note.timeMs);
        if (finger < 0) throw Error('More than two fingers');
        const end = note.endTimeMs ?? note.timeMs + 32 * rate;
        available[finger] = end;
        actions.push({ time: note.timeMs, type: 'pointerdown', finger, lane: note.lane, id: note.id });
        if (note.kind === 'flick') actions.push({ time: note.timeMs + 16 * rate, type: 'pointermove', finger, lane: note.lane + note.direction * .45 });
        if (note.kind === 'slide') for (let time = note.timeMs + 20; time < end; time += 20) {
          let lane = note.lane;
          for (let i = 1; i < note.path.length; i++) if (time <= note.path[i].timeMs) {
            const a = note.path[i - 1], b = note.path[i];
            lane = a.lane + (b.lane - a.lane) * (time - a.timeMs) / (b.timeMs - a.timeMs); break;
          }
          actions.push({ time, type: 'pointermove', finger, lane });
        }
        actions.push({ time: end, type: 'pointerup', finger, lane: note.targetLane ?? note.lane });
      }
      actions.sort((a, b) => a.time - b.time || (a.type === 'pointerup' ? -1 : b.type === 'pointerup' ? 1 : 0));
      let index = 0;
      try {
        await new Promise(resolve => {
          const step = () => {
            const time = api.transport.sourceTimeAt();
            while (index < actions.length && actions[index].time <= time) {
              const action = actions[index++];
              const target = action.type === 'pointerdown' ? api.getTileRects().find(tile => tile.id === action.id) : undefined;
              const y = target ? Math.max(2, Math.min(box.height - 2, (target.top + target.bottom) / 2)) : box.height - 106;
              canvas.dispatchEvent(new PointerEvent(action.type, { bubbles: true, cancelable: true, pointerId: 100 + action.finger, pointerType: 'touch', isPrimary: action.finger === 0, clientX: box.x + (action.lane + .5) * box.width / 4, clientY: box.y + y, buttons: action.type === 'pointerup' ? 0 : 1, pressure: .5 }));
            }
            if (index === actions.length) resolve(); else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        return { audio: api.getMetrics(), render: api.getPerformance(), counts: api.getEngine().counts };
      } finally { canvas.setPointerCapture = originalCapture; }
    });
    await page.getByRole('button', { name: 'Choose song', exact: true }).waitFor({ timeout: 15000 });
    const result = await page.evaluate(() => JSON.parse(localStorage.getItem('afterbeat.progress.v1')).results.at(-1));
    if (!result.completed || result.practice || result.difficulty !== difficulty || result.accuracy < 98 || result.counts.miss) throw Error('Ranked run failed: ' + JSON.stringify(result));
    runs.push({ difficulty, result, metrics });
    await page.screenshot({ path: `output/base44/import-${difficulty}-results.png` });
    await page.getByRole('button', { name: 'Choose song', exact: true }).click();
    if (difficulty !== 'expert') await page.getByRole('button', { name: new RegExp(title + ' artwork ' + title) }).click();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const skin of ['crimson', 'silver']) if (await page.getByRole('radio', { name: skin, exact: true }).isDisabled()) throw Error(skin + ' reward stayed locked');
  await page.getByRole('radio', { name: 'silver', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'silver', exact: true }).waitFor();
  if (await page.getByRole('radio', { name: 'silver', exact: true }).getAttribute('aria-checked') !== 'true') throw Error('Earned finish did not persist');
  await page.screenshot({ path: 'output/base44/earned-finish-persisted.png' });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('tab', { name: 'Recent', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(title + ' artwork ' + title) }).waitFor();
  await page.screenshot({ path: 'output/base44/import-recent-persisted.png' });
  // CLI returns early while a native confirm dialog is present; retain the
  // completed assertions so a later read can recover the report after cleanup.
  const report = { passed: true, environment: 'Base44 normal source draft /; own CLI browser profile; synthetic touch input for ranked progression, not physical latency', imported, duplicateRows: 1, favoriteReload: true, recentReload: true, earnedFinishReload: true, largeOutboundRequests: audioRequests, runs };
  await page.evaluate(value => { sessionStorage.setItem('susika.qa.library-report', JSON.stringify(value)); }, report);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete imported song ' + title, exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Delete imported song QA Original Piano"]'));
  await page.reload();
  const remaining = await savedSongs();
  if (remaining.some(song => song.id === imported.id)) throw Error('Fixture deletion did not persist');
  page.off('request', observe);
  if (audioRequests.length) throw Error('Unexpected large outbound request during local import');
  return { ...report, fixtureDeletionReload: true };
}
