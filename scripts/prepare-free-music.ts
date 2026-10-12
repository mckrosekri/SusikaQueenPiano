import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { analyzePCM } from '../src/rhythm/analysis';
import { generateCharts, validateChart } from '../src/rhythm/chart';
import { classifyDiagnostic, OperationError, type DiagnosticContext, type SafeDiagnostic } from '../src/services/diagnostics';
import { DIFFICULTIES, RATES, type Song } from '../src/types';
import { reconcileTempo, tempoComparison } from './generate-demo-charts';

const licenseUrl = 'https://creativecommons.org/licenses/by/4.0/';
const catalogUrl = 'https://incompetech.com/music/royalty-free/pieces.json';
const musicProvider = 'incompetech';
const reportedFailures = new WeakSet<object>();

type Track = {
  id: string; title: string; artist: string; isrc: string; bpm: number; genre: string;
  filename: string; sourceUrl: string; downloadUrl: string; expectedSourceSha256: string;
  license: string; licenseUrl: string; featuredOrder: number;
};

type DiagnosticPersister = (diagnostic: SafeDiagnostic) => Promise<void>;

async function persistFailure(diagnostic: SafeDiagnostic) {
  await mkdir('output', { recursive: true });
  await writeFile('output/free-music-failure.json', JSON.stringify(diagnostic));
}

export async function musicOperation<T>(
  operation: string,
  action: () => Promise<T>,
  context: Partial<DiagnosticContext> = {},
  sink: (diagnostic: SafeDiagnostic) => void = diagnostic => console.error(JSON.stringify(diagnostic)),
  persist: DiagnosticPersister = persistFailure,
): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } catch (error) {
    if (error && typeof error === 'object' && reportedFailures.has(error)) throw error;
    const diagnostic = classifyDiagnostic(error, {
      operation,
      correlationId: randomUUID(),
      durationMs: performance.now() - started,
      fallback: 'previous_catalog_preserved',
      ...context,
    });
    if (error && typeof error === 'object') reportedFailures.add(error);
    try { sink(diagnostic); } catch { /* Preserve the primary failure. */ }
    try { await persist(diagnostic); } catch { /* Diagnostic persistence is best effort. */ }
    throw error;
  }
}

function responseRequestId(response: Response): string | undefined {
  for (const header of ['x-request-id', 'x-amz-request-id', 'cf-ray', 'traceparent']) {
    const value = response.headers.get(header);
    if (value) return value;
  }
  return undefined;
}

export async function fetchMusic(url: string, fetcher: typeof fetch = fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'TimeoutError';
    throw new OperationError(timeout ? 'music_download_timeout' : 'music_download_network_failed', 'music.download', {
      cause: error,
      diagnostic: { provider: musicProvider, retryable: true },
    });
  }
  if (!response.ok) {
    throw new OperationError('music_download_http_failed', 'music.download', {
      diagnostic: {
        provider: musicProvider,
        providerRequestId: responseRequestId(response),
        httpStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    });
  }
  return response;
}

function tool(args: string[], operation: string): Buffer {
  const result = spawnSync('ffmpeg', args, { encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new OperationError('ffmpeg_launch_failed', operation, { cause: result.error, diagnostic: { provider: 'ffmpeg' } });
  if (result.status !== 0) throw new OperationError('ffmpeg_processing_failed', operation, { diagnostic: { provider: 'ffmpeg' } });
  return result.stdout;
}

function assertWithin(workspaceRoot: string, path: string) {
  const pathRelative = relative(workspaceRoot, path);
  if (!pathRelative || pathRelative === '..' || pathRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathRelative)) {
    throw new OperationError('music_publish_path_invalid', 'music.publish_bundle');
  }
}

async function pathExists(path: string) {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function validateStagedMedia(stage: string, tracks: Track[]) {
  const expectedAudio = tracks.map(track => `${track.id}.mp3`).sort();
  const expectedCharts = tracks.map(track => `${track.id}.json`).sort();
  for (const [directory, expected] of [['audio', expectedAudio], ['charts', expectedCharts]] as const) {
    const entries = await readdir(join(stage, directory), { withFileTypes: true });
    const actual = entries.map(entry => entry.name).sort();
    if (entries.some(entry => !entry.isFile()) || actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new OperationError('music_staging_contents_invalid', 'music.publish_bundle');
    }
  }
}

type PublishHooks = { afterCommit?: (target: string, index: number) => void | Promise<void> };

export async function publishStagedBundle(stagePath: string, workspacePath = resolve('.'), hooks: PublishHooks = {}) {
  const workspaceRoot = resolve(workspacePath);
  const stage = resolve(stagePath);
  const backupRoot = resolve(workspaceRoot, 'output', `free-music-publish-backup-${randomUUID()}`);
  const entries = [
    { staged: join(stage, 'audio'), target: resolve(workspaceRoot, 'public/audio') },
    { staged: join(stage, 'charts'), target: resolve(workspaceRoot, 'public/charts') },
    { staged: join(stage, 'catalog.ts'), target: resolve(workspaceRoot, 'src/data/catalog.ts') },
    { staged: join(stage, 'provenance.json'), target: resolve(workspaceRoot, 'public/licenses/provenance.json') },
    { staged: join(stage, 'attribution.txt'), target: resolve(workspaceRoot, 'public/licenses/attribution.txt') },
    { staged: join(stage, 'review.json'), target: resolve(workspaceRoot, 'output/free-music-chart-review.json') },
  ].map((entry, index) => ({ ...entry, backup: join(backupRoot, String(index)) }));

  assertWithin(workspaceRoot, stage);
  assertWithin(workspaceRoot, backupRoot);
  for (const entry of entries) {
    assertWithin(workspaceRoot, entry.staged);
    assertWithin(workspaceRoot, entry.target);
    assertWithin(workspaceRoot, entry.backup);
    if (!await pathExists(entry.staged)) throw new OperationError('music_staging_contents_invalid', 'music.publish_bundle');
  }

  const backedUp: typeof entries = [];
  const committed: typeof entries = [];
  try {
    await mkdir(backupRoot, { recursive: true });
    for (const entry of entries) {
      if (await pathExists(entry.target)) {
        await mkdir(dirname(entry.backup), { recursive: true });
        await rename(entry.target, entry.backup);
        backedUp.push(entry);
      }
    }
    for (const [index, entry] of entries.entries()) {
      await mkdir(dirname(entry.target), { recursive: true });
      await rename(entry.staged, entry.target);
      committed.push(entry);
      await hooks.afterCommit?.(entry.target, index);
    }
  } catch (primaryError) {
    let rollbackFailed = false;
    for (const entry of [...committed].reverse()) {
      try {
        if (await pathExists(entry.target)) {
          await mkdir(dirname(entry.staged), { recursive: true });
          await rename(entry.target, entry.staged);
        }
      } catch { rollbackFailed = true; /* Continue restoring the prior published bundle. */ }
    }
    for (const entry of [...backedUp].reverse()) {
      try {
        if (await pathExists(entry.backup)) {
          await rm(entry.target, { recursive: true, force: true });
          await mkdir(dirname(entry.target), { recursive: true });
          await rename(entry.backup, entry.target);
        }
      } catch { rollbackFailed = true; /* Preserve the primary publication failure. */ }
    }
    if (!rollbackFailed) {
      try { await rm(backupRoot, { recursive: true, force: true }); } catch { /* Fail soft. */ }
    }
    throw primaryError;
  }
  try { await rm(backupRoot, { recursive: true, force: true }); } catch { /* Published content is already committed. */ }
}

export async function prepareFreeMusic() {
  const tracks: Track[] = JSON.parse(await readFile('scripts/free-music.json', 'utf8'));
  const validIds = tracks.every(track => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(track.id));
  const validHashes = tracks.every(track => /^[a-f0-9]{64}$/.test(track.expectedSourceSha256));
  if (tracks.length !== 10 || new Set(tracks.map(track => track.id)).size !== 10 || !validIds || !validHashes) {
    throw new OperationError('music_manifest_invalid', 'music.prepare');
  }

  let catalogResponse: Response | undefined;
  const primary = await musicOperation('music.catalog', async () => {
    catalogResponse = await fetchMusic(catalogUrl);
    try { return await catalogResponse.json(); }
    catch (error) {
      throw new OperationError('music_catalog_invalid', 'music.catalog', {
        cause: error,
        diagnostic: { provider: musicProvider, providerRequestId: responseRequestId(catalogResponse), retryable: false },
      });
    }
  }, { provider: musicProvider });
  if (!Array.isArray(primary)) throw new OperationError('music_catalog_invalid', 'music.catalog');

  const stage = resolve('output/free-music-staging');
  await rm(stage, { recursive: true, force: true });
  await Promise.all(['audio', 'charts'].map(directory => mkdir(join(stage, directory), { recursive: true })));
  const songs: Song[] = [], provenance: object[] = [], reviews: object[] = [];

  for (const [index, track] of tracks.entries()) await musicOperation('music.prepare_track', async () => {
    const record = primary.find((piece: { isrc?: string; title?: string; filename?: string; bpm?: string }) => piece.isrc === track.isrc && piece.title === track.title && piece.filename === track.filename && Number(piece.bpm) === track.bpm);
    if (!record || track.license !== 'CC-BY-4.0' || track.licenseUrl !== licenseUrl) {
      throw new OperationError('music_source_mismatch', 'music.prepare_track', { diagnostic: { provider: musicProvider } });
    }
    const response = await fetchMusic(track.downloadUrl);
    const requestId = responseRequestId(response);
    if (!/audio|octet-stream/i.test(response.headers.get('content-type') ?? '')) {
      throw new OperationError('music_response_type_invalid', 'music.prepare_track', { diagnostic: { provider: musicProvider, providerRequestId: requestId } });
    }
    const source = Buffer.from(await response.arrayBuffer());
    if (!source.length) throw new OperationError('music_response_empty', 'music.prepare_track', { diagnostic: { provider: musicProvider, providerRequestId: requestId } });
    const sourceHash = createHash('sha256').update(source).digest('hex');
    if (sourceHash !== track.expectedSourceSha256) {
      throw new OperationError('music_source_hash_mismatch', 'music.prepare_track', { diagnostic: { provider: musicProvider, providerRequestId: requestId, retryable: false } });
    }

    const sourcePath = join(stage, `${track.id}.source.mp3`), audioPath = join(stage, 'audio', `${track.id}.mp3`);
    await writeFile(sourcePath, source);
    tool(['-v', 'error', '-y', '-i', sourcePath, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '112k', '-ar', '44100', audioPath], 'music.encode');
    const bytes = await readFile(audioPath), audioHash = createHash('sha256').update(bytes).digest('hex');
    const pcmBytes = tool(['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'], 'music.decode');
    const pcm = new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 4).slice();
    const raw = analyzePCM(pcm, 22050, audioHash), analysis = reconcileTempo(raw, track.bpm, tempoComparison(raw.bpm, track.bpm));
    const charts = generateCharts(analysis);
    const errors = RATES.flatMap(rate => DIFFICULTIES.flatMap(difficulty => validateChart(charts[difficulty], rate)));
    if (errors.length || DIFFICULTIES.some(difficulty => !charts[difficulty].notes.length)) throw new OperationError('music_chart_validation_failed', 'music.prepare_track');
    await writeFile(join(stage, 'charts', `${track.id}.json`), JSON.stringify(analysis) + '\n');
    const credit = `${track.title} — Kevin MacLeod (incompetech.com). Licensed under Creative Commons Attribution 4.0 International (${licenseUrl}). Re-encoded to 112 kbps MP3; no musical edits. Playback speed may be changed by the player.`;
    songs.push({ id: track.id, title: track.title, artist: track.artist, genre: track.genre, durationMs: analysis.durationMs, bpm: analysis.bpm, source: 'bundled', color: `oklch(0.72 0.13 ${[347,65,285,150,25,307,325,355,15,65][index]})`, featuredOrder: track.featuredOrder, audioUrl: `/audio/${track.id}.mp3`, audioHash, licenseUrl, sourceUrl: track.sourceUrl, credit });
    provenance.push({ ...track, sourceCatalog: catalogUrl, sourceSha256: sourceHash, audioSha256: audioHash, audioBytes: bytes.length, changes: 'Re-encoded to 112 kbps MP3; metadata stripped. No musical edits. Player-selected playback speed.', primaryRecord: { title: record.title, filename: record.filename, isrc: record.isrc, bpm: record.bpm }, credit });
    reviews.push({ id: track.id, audioHash, durationMs: analysis.durationMs, rawBpm: raw.bpm, bundledBpm: analysis.bpm, confidence: raw.confidence, validationErrors: errors.length, difficulties: Object.fromEntries(DIFFICULTIES.map(difficulty => [difficulty, { notes: charts[difficulty].notes.length, taps: charts[difficulty].notes.filter(note => note.kind === 'tap').length, holds: charts[difficulty].notes.filter(note => note.kind === 'hold').length, slides: charts[difficulty].notes.filter(note => note.kind === 'slide').length }])) });
    console.log(`[${index + 1}/10] ${track.title}: ${analysis.bpm} BPM; ${charts.normal.notes.length} notes; validated at all four speeds.`);
  });

  await writeFile(join(stage, 'catalog.ts'), `import type { Song } from '../types';\n\nexport const BUNDLED_SONGS: Song[] = ${JSON.stringify(songs, null, 2)};\n`);
  await writeFile(join(stage, 'provenance.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), artist: 'Kevin MacLeod', license: 'CC-BY-4.0', licenseUrl, tracks: provenance }, null, 2) + '\n');
  await writeFile(join(stage, 'attribution.txt'), `SusikaQueenPiano music credits\n\nAll 10 recordings by Kevin MacLeod (incompetech.com).\nLicensed under Creative Commons Attribution 4.0 International.\n${licenseUrl}\nMusic is separately licensed from the MIT game code. No endorsement is implied.\n\n${songs.map(song => `${song.credit}\nOriginal recording: ${song.sourceUrl}\nBundled file: ${song.audioUrl}\n`).join('\n')}`);
  await writeFile(join(stage, 'review.json'), JSON.stringify({ songs: reviews, methodology: 'Exact bundled MP3 decoded at 22.05 kHz, measured onsets, source BPM with signal-fitted phase, conservative holds, two-finger validation at every difficulty and speed. Automated validation does not assert human listening approval.' }, null, 2));
  await validateStagedMedia(stage, tracks);
  await musicOperation('music.publish_bundle', () => publishStagedBundle(stage), { fallback: 'previous_catalog_restored' });
}
