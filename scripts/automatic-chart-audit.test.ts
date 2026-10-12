import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { generateCharts, validateChart } from '../src/rhythm/chart';
import { DIFFICULTIES, RATES, type BeatAnalysis } from '../src/types';

describe('full bundled automatic arrangements', () => {
  for (const file of readdirSync('public/charts').filter(file => file.endsWith('.json'))) {
    it(`${file}: measured attacks, nested difficulty, tap-led gestures and all-rate playability`, () => {
      const analysis: BeatAnalysis = JSON.parse(readFileSync(`public/charts/${file}`, 'utf8'));
      const charts = generateCharts(analysis);
      const onsetTimes = new Set(analysis.onsets.map(onset => onset.timeMs));
      for (let i = 0; i < DIFFICULTIES.length; i += 1) {
        const chart = charts[DIFFICULTIES[i]];
        expect(chart.notes.length).toBeGreaterThan(0);
        expect(chart.notes.every(note => onsetTimes.has(note.timeMs))).toBe(true);
        expect(chart.notes.filter(note => note.kind === 'tap').length / chart.notes.length).toBeGreaterThan(0.9);
        for (const rate of RATES) expect(validateChart(chart, rate)).toEqual([]);
        if (i > 0) {
          const previous = charts[DIFFICULTIES[i - 1]];
          expect(chart.notes.length).toBeGreaterThan(previous.notes.length);
          const times = new Set(chart.notes.map(note => note.timeMs));
          expect(previous.notes.every(note => times.has(note.timeMs))).toBe(true);
        }
      }
    });
  }
});
