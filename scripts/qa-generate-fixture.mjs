import { mkdirSync, writeFileSync } from 'node:fs';

// Original test signal: attacks of varying strength and measured tonal tails.
// This is a disposable library/import fixture, not a demo music asset.
const sampleRate = 22050, duration = 12, count = sampleRate * duration;
const samples = new Float32Array(count);
for (let beat = 0; beat < 22; beat++) {
  const start = .4 + beat * .5;
  const length = beat % 4 === 0 ? .42 : .14;
  const amplitude = [.7, .25, .48, .18][beat % 4];
  const frequency = [440, 554.37, 659.25, 880][beat % 4];
  for (let i = 0; i < length * sampleRate; i++) {
    const at = Math.round(start * sampleRate) + i, t = i / sampleRate;
    const envelope = Math.min(1, t / .005) * Math.min(1, (length - t) / .03);
    samples[at] += amplitude * envelope * (Math.sin(2 * Math.PI * frequency * t) + .12 * Math.sin(4 * Math.PI * frequency * t));
  }
}
const wav = Buffer.alloc(44 + count * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
samples.forEach((value, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
mkdirSync('output/playwright', { recursive: true });
writeFileSync('output/playwright/QA Original Piano.wav', wav);
console.log(JSON.stringify({ path: 'output/playwright/QA Original Piano.wav', duration, sampleRate, bytes: wav.length }));
