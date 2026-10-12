import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { CHART_VERSION, generateCharts, validateChart } = await server.ssrLoadModule('/src/rhythm/chart.ts');
  const rows = [], errors = [];
  const analyses = readdirSync('public/charts').filter(file => file.endsWith('.json'))
    .map(file => ({ name: file, analysis: JSON.parse(readFileSync(`public/charts/${file}`, 'utf8')) }));
  for (const { name, analysis } of analyses) {
    for (const chart of Object.values(generateCharts(analysis))) {
      for (const rate of [.75, 1, 1.25, 1.5]) {
        // Independent event sweep against the agreed wall-clock command budget.
        const events = chart.notes.flatMap(note => {
          const end = note.kind === 'hold' || note.kind === 'slide'
            ? note.endTimeMs + 80 * rate
            : note.timeMs + (note.kind === 'flick' ? 220 : 120) * rate;
          return [{ time: note.timeMs, delta: 1 }, { time: end, delta: -1 }];
        }).sort((a, b) => a.time - b.time || a.delta - b.delta);
        let active = 0, peak = 0;
        for (const event of events) { active += event.delta; peak = Math.max(peak, active); }
        const validation = validateChart(chart, rate);
        rows.push({ song: name, difficulty: chart.difficulty, rate, notes: chart.notes.length, peakRequiredFingers: peak });
        if (peak > 2 || validation.length) errors.push({ song: name, difficulty: chart.difficulty, rate, peak, validation });
      }
    }
  }
  const report = { verifiedUtc: new Date().toISOString(), version: CHART_VERSION,
    bundledSongs: analyses.length, arrangements: analyses.length * 4,
    speedChecks: rows.length, maximumRequiredFingers: Math.max(...rows.map(row => row.peakRequiredFingers)),
    wallClockBudgetMs: { tap: 120, flick: 220, sustainRelease: 80 }, errors, rows };
  mkdirSync('output', { recursive: true });
  writeFileSync('output/two-finger-arrangement-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ arrangements: report.arrangements, speedChecks: report.speedChecks,
    maximumRequiredFingers: report.maximumRequiredFingers, errors: errors.length }));
  if (errors.length) process.exitCode = 1;
} finally { await server.close(); }
