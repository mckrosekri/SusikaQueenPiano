async page => {
  const physical = page.url() === 'https://localhost/';
  const proofPrefix = physical ? 'auto-v4-phone' : 'auto-v4-driver';
  const recoveryKey = 'susika.qa.device-sample.v1';
  // Recover a previous bounded observer before installing another one.
  await page.evaluate(() => {
    const previous = window.__phoneAudio;
    if (previous?.restore) previous.restore();
    else if (previous?.originals) {
      window.AudioContext = previous.originals.AudioContext;
      window.AudioWorkletNode = previous.originals.AudioWorkletNode;
      delete window.__phoneAudio;
    }
    const originals = { AudioContext, OfflineAudioContext, AudioWorkletNode };
    const obs = { contexts: [], nodes: [] };
    const listeners = [];
    let active = true;
    let timer;
    const restore = () => {
      active = false;
      clearTimeout(timer);
      window.AudioContext = originals.AudioContext;
      window.AudioWorkletNode = originals.AudioWorkletNode;
      for (const [node, listener] of listeners) node.removeEventListener('metrics', listener);
      const canvas = document.querySelector('canvas');
      if (canvas?.__qaOriginalCapture) {
        canvas.setPointerCapture = canvas.__qaOriginalCapture;
        delete canvas.__qaOriginalCapture;
      }
      if (window.__phoneAudio?.restore === restore) delete window.__phoneAudio;
    };
    window.__phoneAudio = { originals, obs, restore };
    timer = setTimeout(restore, 90_000); // Also cleans up when the host disconnects.
    window.AudioContext = new Proxy(originals.AudioContext, { construct(t, a, n) {
      const context = Reflect.construct(t, a, n); if (active) obs.contexts.push(context); return context;
    } });
    window.AudioWorkletNode = new Proxy(originals.AudioWorkletNode, { construct(t, a, n) {
      const node = Reflect.construct(t, a, n);
      if (!active) return node; // Cached SoundTouch subclasses may retain this proxy after restore.
      const record = { offline: a[0] instanceof originals.OfflineAudioContext, processor: a[1], metrics: [] };
      obs.nodes.push(record);
      const listener = () => {
        record.metrics.push({ time: performance.now(), underruns: node.metrics?.underrunCount ?? null });
        if (record.metrics.length > 256) record.metrics.shift();
      };
      listeners.push([node, listener]);
      node.addEventListener('metrics', listener);
      return node;
    } });
  });
  const runs = [];
  try {
    const priorExit = page.getByRole('button', { name: 'Exit song', exact: true });
    if (await priorExit.isVisible()) await priorExit.click();
    for (const scenario of [
      { title: 'Carefree', difficulty: 'normal', rate: 1, start: 0, end: 30, measure: 22000 },
      { title: 'The Cannery', difficulty: 'expert', rate: 1.5, start: 10, end: 55, measure: 22000 },
    ]) {
      await page.getByRole('button', { name: 'Song library', exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`${scenario.title} artwork ${scenario.title}`) }).click();
      await page.getByRole('radio', { name: scenario.difficulty, exact: true }).click();
      await page.getByRole('radio', { name: `${scenario.rate}×`, exact: true }).click();
      await page.getByRole('checkbox', { name: /Practice section/ }).check();
      await page.getByLabel('Start', { exact: false }).fill(String(scenario.start));
      await page.getByLabel('End', { exact: false }).fill(String(scenario.end));
      await page.getByRole('button', { name: 'Start performance' }).click();
      await page.locator('canvas').waitFor();
      const tutorial = page.getByRole('button', { name: 'Take the stage' });
      if (await tutorial.isVisible()) await tutorial.click();
      await page.waitForTimeout(3500);
      const promise = page.evaluate(({ duration, scenario, recoveryKey, physical }) => new Promise(resolve => {
        const frames = [], from = performance.now(), canvas = document.querySelector('canvas');
        const obs = window.__phoneAudio.obs;
        canvas.__qaOriginalCapture = canvas.setPointerCapture;
        canvas.setPointerCapture = function(id) {
          if (id === 100) return; // Synthetic ID only; real native pointers remain unchanged.
          return canvas.__qaOriginalCapture.call(canvas, id);
        };
        const box = canvas.getBoundingClientRect(); let nextInput = 0, index = 0;
        const step = time => {
          frames.push(time);
          // Synthetic browser mouse input exercises normal effects, never ranked results.
          if (time >= nextInput) {
            const lane = index++ % 4;
            for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, {
              bubbles: true, pointerId: 100, pointerType: 'mouse', isPrimary: true,
              clientX: box.left + (lane + .5) * box.width / 4, clientY: box.top + box.height * .7,
              buttons: type === 'pointerdown' ? 1 : 0,
            }));
            nextInput = time + 160;
          }
          if (time - from < duration) return requestAnimationFrame(step);
          const differences = frames.slice(1).map((v, i) => v - frames[i]).sort((a, b) => a - b);
          const quantile = p => differences[Math.floor((differences.length - 1) * p)];
          const median = quantile(.5), dropped = differences.reduce((n, d) => n + Math.max(0, Math.round(d / median) - 1), 0);
          const report = { scenario, physical, recordedAt: new Date().toISOString(),
            expectedApkSha256: physical ? '66B9DF65F151ED1E9164E74DC070E07AE82E3F5383ADA9FE27408BFFA39053BA' : null,
            durationMs: time - frames[0], frameCount: frames.length, medianMs: median, p95Ms: quantile(.95),
            p99Ms: quantile(.99), maxMs: differences.at(-1), estimatedHz: 1000 / median,
            droppedFrames: dropped, droppedPercent: dropped / (differences.length + dropped) * 100,
            visibility: document.visibilityState, canvasCount: document.querySelectorAll('canvas').length,
            inputCount: index,
            contexts: obs.contexts.map(c => ({ state: c.state, sampleRate: c.sampleRate, baseLatency: c.baseLatency,
              outputLatency: c.outputLatency, outputTimestamp: c.getOutputTimestamp?.() })),
            nodes: obs.nodes.map(n => { const events = n.metrics.filter(m => m.time >= from);
              return { offline: n.offline, processor: n.processor, metricEvents: events.length,
                firstUnderrun: events[0]?.underruns ?? null, lastUnderrun: events.at(-1)?.underruns ?? null,
                underrunDelta: events.length ? events.at(-1).underruns - events[0].underruns : null }; }),
          };
          window.__phoneRunReports ??= [];
          window.__phoneRunReports.push(report);
          // Only safe timing metadata is persisted; no audio, app settings or scores.
          try {
            const prior = JSON.parse(sessionStorage.getItem(recoveryKey) || '[]');
            sessionStorage.setItem(recoveryKey, JSON.stringify([...prior, report].slice(-8)));
          } catch { /* Recoverable evidence must never interrupt gameplay. */ }
          canvas.setPointerCapture = canvas.__qaOriginalCapture;
          delete canvas.__qaOriginalCapture;
          resolve(report);
        }; requestAnimationFrame(step);
      }), { duration: physical ? scenario.measure : 8000, scenario, recoveryKey, physical });
      await page.waitForTimeout(4000);
      await page.screenshot({ path: `output/android/${proofPrefix}-${scenario.difficulty}-play.png` });
      const report = await promise;
      if (report.visibility !== 'visible' || report.canvasCount !== 1 || report.droppedPercent >= 1 ||
        report.estimatedHz < 55 || report.p95Ms > 25 || !report.contexts.some(context => context.state === 'running') ||
        (scenario.rate !== 1 && !report.nodes.some(node => !node.offline && node.metricEvents > 10 && node.underrunDelta === 0))) {
        throw Error(JSON.stringify(report));
      }
      runs.push({ scenario, report });
      const exit = page.getByRole('button', { name: 'Exit song', exact: true });
      if (await exit.isVisible()) await exit.click();
      else await page.getByRole('button', { name: 'Choose song', exact: true }).click();
    }
    return { passed: true, physical,
      scope: physical ? 'Physical Android WebView cadence and worklet underruns; synthetic mouse handlers with capture bypass; no microphone latency or physical multitouch measurement'
        : 'Desktop validation of the device QA driver; no physical evidence', runs };
  } finally {
    await page.evaluate(() => {
      window.__phoneAudio?.restore();
    }).catch(() => {}); // A disconnected host leaves the in-page cleanup watchdog active.
  }
}
