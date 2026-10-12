async page => {
  const state = await page.evaluate(async () => {
    const progress = JSON.parse(localStorage.getItem('afterbeat.progress.v1'));
    const songs = await new Promise((resolve, reject) => {
      const open = indexedDB.open('afterbeat-library', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, get = db.transaction('songs').objectStore('songs').getAll(); get.onsuccess = () => { resolve(get.result.map(song => ({ id: song.id, title: song.title }))); db.close(); }; get.onerror = () => reject(get.error); };
    });
    return { progress, songs, retainedReport: JSON.parse(sessionStorage.getItem('susika.qa.library-report') || 'null') };
  });
  const runs = state.progress.results.filter(result => result.songId.startsWith('local-'));
  const latest = Object.fromEntries(['easy', 'normal', 'hard', 'expert'].map(difficulty => [difficulty, runs.filter(result => result.difficulty === difficulty).at(-1)]));
  for (const [difficulty, result] of Object.entries(latest)) if (!result?.completed || result.practice || result.accuracy < 98 || result.counts.miss) throw Error('Missing persisted ranked result: ' + difficulty);
  if (new Set(Object.values(latest).map(result => result.songId)).size !== 1) throw Error('Ranked fixture IDs differ');
  if (state.songs.some(song => song.title === 'QA Original Piano')) throw Error('QA fixture deletion did not persist');
  if (state.progress.settings.skin !== 'silver') throw Error('Earned finish did not persist');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const skin of ['crimson', 'silver']) if (await page.getByRole('radio', { name: skin, exact: true }).isDisabled()) throw Error('Earned reward remained locked: ' + skin);
  await page.screenshot({ path: 'output/base44/earned-finish-persisted.png' });
  return { passed: true, environment: 'Base44 normal source preview; isolated headless CLI profile; synthetic two-finger scoring, not physical touch', runner: 'qa-library-progression.js assertions completed through recent screenshot; CLI returned early on auto-accepted deletion dialog; this check verifies final persisted state', favoriteAndRecentReloadScreenshots: true, duplicateImportAssertedSingleRow: true, persistedRankedResults: latest, earnedCrimsonAndSilver: true, selectedSilverPersists: true, fixtureDeletionPersists: true, remainingImportedSongs: state.songs.length, ...(state.retainedReport ? { runReport: state.retainedReport } : {}) };
}
