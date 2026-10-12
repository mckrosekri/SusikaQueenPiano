async (page) => {
  return page.evaluate(async () => {
    const { SoundTouchNode } = await import('/node_modules/@soundtouchjs/audio-worklet/.dist/SoundTouchNode.js');
    const { measureDspDelay } = await import('/src/audio/transport.ts');
    const sampleRate = 24000;
    const duration = 301;
    const marks = [1, 60, 150, 299];
    const burstSeconds = 0.12;
    const processorWarmupSeconds = 2.5;
    const reports = [];

    const addBurst = (data, start, length, seed) => {
      for (let i = 0; i < length && start + i < data.length; i += 1) {
        const edge = Math.min(1, i / 24, (length - 1 - i) / 24);
        data[start + i] += 0.72 * Math.sin((i + 1) * 12.9898 + seed * 78.233) * Math.max(0, edge);
      }
    };
    const findOnset = (data, expectedSeconds) => {
      const from = Math.max(0, Math.floor((expectedSeconds - 0.025) * sampleRate));
      const to = Math.min(data.length, Math.ceil((expectedSeconds + 0.3) * sampleRate));
      for (let i = from; i < to; i += 1) if (Math.abs(data[i]) >= 0.075) return i / sampleRate;
      return null;
    };

    for (const rate of [0.75, 1, 1.25, 1.5]) {
      const context = new OfflineAudioContext(2, Math.ceil(sampleRate * (processorWarmupSeconds + duration / rate + 0.35)), sampleRate);
      const buffer = context.createBuffer(2, sampleRate * duration, sampleRate);
      for (const channel of [0, 1]) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i += 1) data[i] = 0.025 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
        marks.forEach((time, index) => addBurst(data, Math.round(time * sampleRate), Math.round(sampleRate * burstSeconds), index + 1));
      }

      let processor;
      if (rate !== 1) {
        await SoundTouchNode.register(context, '/node_modules/@soundtouchjs/audio-worklet/.dist/soundtouch-processor.js');
        processor = new SoundTouchNode({ context });
        processor.playbackRate.value = rate;
        processor.pitch.value = 1;
        processor.setStretchParameters({ sequenceMs: 40, seekWindowMs: 15, overlapMs: 8, quickSeek: true });
        processor.connect(context.destination);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.connect(processor ?? context.destination);
      source.start(processorWarmupSeconds);
      const rendered = await context.startRendering();
      const data = rendered.getChannelData(0);
      let calibrationMs = 0;
      let calibrationError;
      try {
        calibrationMs = await measureDspDelay(rate, sampleRate) * 1000;
      } catch (error) {
        calibrationError = `${error.name}:${error.reason ?? 'unknown'}`;
      }
      const delays = marks.map((sourceSeconds) => {
        const expectedSeconds = processorWarmupSeconds + sourceSeconds / rate;
        const onset = findOnset(data, expectedSeconds);
        return { sourceSeconds, delayMs: onset === null ? null : (onset - expectedSeconds) * 1000 };
      });
      const pitchStart = Math.floor((processorWarmupSeconds + 50 / rate + calibrationMs / 1000) * sampleRate);
      const pitchEnd = Math.min(data.length, pitchStart + sampleRate * 2);
      let positiveCrossings = 0;
      for (let i = pitchStart + 1; i < pitchEnd; i += 1) if (data[i - 1] <= 0 && data[i] > 0) positiveCrossings += 1;
      const estimatedPitchHz = positiveCrossings / ((pitchEnd - pitchStart) / sampleRate);
      const measuredDelays = delays.map((entry) => entry.delayMs).filter((value) => value !== null);
      const steadyDelays = delays.slice(1).map((entry) => entry.delayMs).filter((value) => value !== null);
      const report = {
        rate,
        sourcePlaybackRate: source.playbackRate.value,
        processorPlaybackRate: processor?.playbackRate.value ?? 1,
        calibrationMs,
        calibrationError,
        delays,
        estimatedPitchHz,
        pitchErrorPercent: Math.abs(estimatedPitchHz - 440) / 440 * 100,
        fullSpanDelayVariationMs: measuredDelays.length < 2 ? null : Math.max(...measuredDelays) - Math.min(...measuredDelays),
        startupResidualMs: measuredDelays.length === 0 ? null : Math.abs(measuredDelays[0] - calibrationMs),
        steadyDriftMs: steadyDelays.length < 2 ? null : Math.abs(steadyDelays.at(-1) - steadyDelays[0]),
        steadyMaxResidualMs: steadyDelays.length === 0 ? null : Math.max(...steadyDelays.map((delay) => Math.abs(delay - calibrationMs))),
      };
      report.passed = !report.calibrationError
        && report.delays.every((entry) => entry.delayMs !== null)
        && report.pitchErrorPercent <= 1
        && report.steadyDriftMs <= 10
        && report.steadyMaxResidualMs <= 33.34
        && report.startupResidualMs <= 33.34;
      reports.push(report);
      processor?.disconnect();
      source.disconnect();
    }
    return {
      environment: 'Headless Chrome OfflineAudioContext, 24 kHz, five-minute synthetic 440 Hz signal with 120 ms correlated markers; physical output path not measured',
      acceptance: { pitchErrorPercentMax: 1, steadyDriftMsMax: 10, localResidualMsMax: 33.34 },
      passed: reports.every((report) => report.passed),
      limits: 'Offline browser DSP only. Physical Android output latency remains outside this probe and is handled by calibration.',
      reports,
    };
  });
}
