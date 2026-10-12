import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchMusic, musicOperation, publishStagedBundle } from './prepare-free-music';
import { OperationError, type SafeDiagnostic } from '../src/services/diagnostics';

const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('keeps provider HTTP metadata and correlation without response content', async () => {
  const diagnostics: SafeDiagnostic[] = [];
  const persisted: SafeDiagnostic[] = [];
  const fetcher = (async () => new Response('SECRET_MEDIA_PAYLOAD', {
    status: 503,
    headers: { 'x-request-id': 'req-503' },
  })) as typeof fetch;

  await expect(musicOperation(
    'music.catalog',
    () => fetchMusic('https://example.com/file', fetcher),
    { provider: 'incompetech', correlationId: 'test-correlation' },
    diagnostic => diagnostics.push(diagnostic),
    async diagnostic => { persisted.push(diagnostic); },
  )).rejects.toMatchObject({ reason: 'music_download_http_failed' });

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    operation: 'music.catalog',
    reason: 'music_download_http_failed',
    exceptionClass: 'OperationError',
    httpStatus: 503,
    retryable: true,
    provider: 'incompetech',
    providerRequestId: 'req-503',
    correlationId: 'test-correlation',
  });
  expect(persisted).toEqual(diagnostics);
  expect(JSON.stringify(diagnostics)).not.toContain('SECRET_MEDIA_PAYLOAD');
});

it('classifies network failures without exposing the thrown message', async () => {
  let recorded: SafeDiagnostic | undefined;
  const fetcher = (async () => { throw new Error('SECRET_TOKEN customer payload'); }) as typeof fetch;
  await expect(musicOperation(
    'music.prepare_track',
    () => fetchMusic('https://example.com/file', fetcher),
    { correlationId: 'track-correlation' },
    diagnostic => { recorded = diagnostic; },
    async () => {},
  )).rejects.toMatchObject({ reason: 'music_download_network_failed' });
  expect(recorded).toMatchObject({
    operation: 'music.prepare_track',
    reason: 'music_download_network_failed',
    provider: 'incompetech',
    retryable: true,
  });
  expect(JSON.stringify(recorded)).not.toMatch(/SECRET_TOKEN|customer payload/);
});

it('retains the primary failure when diagnostic sinks fail', async () => {
  const primary = new OperationError('ffmpeg_launch_failed', 'music.encode', {
    cause: new Error('SECRET_FILE_CONTENT password=secret'),
    diagnostic: { provider: 'ffmpeg' },
  });
  let recorded: SafeDiagnostic | undefined;
  await expect(musicOperation(
    'music.prepare_track',
    async () => { throw primary; },
    { correlationId: 'test-correlation', attempt: 2 },
    diagnostic => { recorded = diagnostic; throw new Error('sink unavailable'); },
    async () => { throw new Error('persistence unavailable'); },
  )).rejects.toBe(primary);
  expect(recorded).toMatchObject({
    reason: 'ffmpeg_launch_failed',
    operation: 'music.prepare_track',
    provider: 'ffmpeg',
    correlationId: 'test-correlation',
    attempt: 2,
    fallback: 'previous_catalog_preserved',
  });
  expect(JSON.stringify(recorded)).not.toMatch(/SECRET|password|sink unavailable|persistence unavailable/);
});

it('records a nested failure once without losing HTTP metadata', async () => {
  const diagnostics: SafeDiagnostic[] = [];
  const persisted: SafeDiagnostic[] = [];
  const fetcher = (async () => new Response('private body', {
    status: 429,
    headers: { 'cf-ray': 'ray-429' },
  })) as typeof fetch;
  const sink = (diagnostic: SafeDiagnostic) => diagnostics.push(diagnostic);
  const persist = async (diagnostic: SafeDiagnostic) => { persisted.push(diagnostic); };

  await expect(musicOperation('outer.publish', () => musicOperation(
    'music.catalog',
    () => fetchMusic('https://example.com/file', fetcher),
    { correlationId: 'nested-correlation' },
    sink,
    persist,
  ), {}, sink, persist)).rejects.toMatchObject({ reason: 'music_download_http_failed' });

  expect(diagnostics).toHaveLength(1);
  expect(persisted).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ operation: 'music.catalog', httpStatus: 429, providerRequestId: 'ray-429', retryable: true });
});

async function createPublishFixture() {
  const root = await mkdtemp(join(tmpdir(), 'afterbeat-publish-'));
  temporaryRoots.push(root);
  const stage = join(root, 'output/free-music-staging');
  const directories = [
    join(stage, 'audio'), join(stage, 'charts'), join(root, 'public/audio'),
    join(root, 'public/charts'), join(root, 'public/licenses'), join(root, 'src/data'), join(root, 'output'),
  ];
  await Promise.all(directories.map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(join(stage, 'audio/new.mp3'), 'new audio'),
    writeFile(join(stage, 'charts/new.json'), 'new chart'),
    writeFile(join(stage, 'catalog.ts'), 'new catalog'),
    writeFile(join(stage, 'provenance.json'), 'new provenance'),
    writeFile(join(stage, 'attribution.txt'), 'new attribution'),
    writeFile(join(stage, 'review.json'), 'new review'),
    writeFile(join(root, 'public/audio/old.mp3'), 'old audio'),
    writeFile(join(root, 'public/audio/obsolete.mp3'), 'obsolete audio'),
    writeFile(join(root, 'public/charts/old.json'), 'old chart'),
    writeFile(join(root, 'src/data/catalog.ts'), 'old catalog'),
    writeFile(join(root, 'public/licenses/provenance.json'), 'old provenance'),
    writeFile(join(root, 'public/licenses/attribution.txt'), 'old attribution'),
    writeFile(join(root, 'output/free-music-chart-review.json'), 'old review'),
  ]);
  return { root, stage };
}

it('commits whole media directories so obsolete files cannot survive', async () => {
  const { root, stage } = await createPublishFixture();
  await publishStagedBundle(stage, root);
  expect(await readdir(join(root, 'public/audio'))).toEqual(['new.mp3']);
  expect(await readdir(join(root, 'public/charts'))).toEqual(['new.json']);
  expect(await readFile(join(root, 'src/data/catalog.ts'), 'utf8')).toBe('new catalog');
  expect(await readFile(join(root, 'public/licenses/provenance.json'), 'utf8')).toBe('new provenance');
  expect(await readFile(join(root, 'output/free-music-chart-review.json'), 'utf8')).toBe('new review');
});

it('restores the exact prior bundle and retains the primary transaction failure', async () => {
  const { root, stage } = await createPublishFixture();
  const primary = new Error('injected commit failure');
  await expect(publishStagedBundle(stage, root, {
    afterCommit: (_target, index) => { if (index === 3) throw primary; },
  })).rejects.toBe(primary);

  expect((await readdir(join(root, 'public/audio'))).sort()).toEqual(['obsolete.mp3', 'old.mp3']);
  expect(await readFile(join(root, 'public/audio/old.mp3'), 'utf8')).toBe('old audio');
  expect(await readFile(join(root, 'public/audio/obsolete.mp3'), 'utf8')).toBe('obsolete audio');
  expect(await readdir(join(root, 'public/charts'))).toEqual(['old.json']);
  expect(await readFile(join(root, 'src/data/catalog.ts'), 'utf8')).toBe('old catalog');
  expect(await readFile(join(root, 'public/licenses/provenance.json'), 'utf8')).toBe('old provenance');
  expect(await readFile(join(root, 'public/licenses/attribution.txt'), 'utf8')).toBe('old attribution');
  expect(await readFile(join(root, 'output/free-music-chart-review.json'), 'utf8')).toBe('old review');
  expect(await readFile(join(stage, 'audio/new.mp3'), 'utf8')).toBe('new audio');
  expect(await readFile(join(stage, 'charts/new.json'), 'utf8')).toBe('new chart');
  expect(await readFile(join(stage, 'catalog.ts'), 'utf8')).toBe('new catalog');
  expect(await readFile(join(stage, 'provenance.json'), 'utf8')).toBe('new provenance');
});
