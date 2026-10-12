import { createServer } from 'vite';
const vite = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, watch: null, hmr: false } });
try {
  const { prepareFreeMusic, musicOperation } = await vite.ssrLoadModule('/scripts/prepare-free-music.ts');
  await musicOperation('music.prepare', () => prepareFreeMusic());
} finally { await vite.close(); }
