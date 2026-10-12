import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Home, LoaderCircle, Settings as SettingsIcon } from 'lucide-react';
import { BUNDLED_SONGS } from './data/catalog';
import { CHART_VERSION, generateCharts } from './rhythm/chart';
import { getSongAnalysis, importSong, isCurrentAnalysis, repairSongAnalysis } from './services/imports';
import { OperationError, reportDiagnostic } from './services/diagnostics';
import { deleteImportedSong, listImportedSongs, loadProgress, saveProgress } from './services/storage';
import type { BeatAnalysis, Chart, Difficulty, Progress, RunConfig, RunResult, Settings, Song } from './types';
import { DEFAULT_SETTINGS } from './types';
import { compactRankedResults, isDifficultyUnlocked, leaderboardFor, nextDifficulty, recommendedDifficulty, starsForResult, unlockedSkins } from './services/progression';
import { Calibration } from './components/Calibration';
import { Library } from './components/Library';
import { MasteryJourney } from './components/MasteryJourney';
import { Results } from './components/Results';
import { SettingsPanel } from './components/SettingsPanel';
import { SongDetails } from './components/SongDetails';

const GameStage = lazy(() => import('./components/GameStage'));
type View = 'library' | 'details' | 'game' | 'results' | 'settings' | 'journey' | 'calibration';
const EMPTY_PROGRESS: Progress = { version: 1, results: [], favorites: [], lastPlayed: {}, settings: DEFAULT_SETTINGS, tutorialComplete: false };

function safeLoadProgress(): Progress {
  try { return loadProgress(); }
  catch (error) {
    reportDiagnostic(error, { operation: 'progress_load', reason: 'local_progress_unavailable', fallback: 'default_progress' });
    return EMPTY_PROGRESS;
  }
}

function readableError(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Import cancelled.';
  if (error instanceof OperationError) {
    const messages: Record<string, string> = {
      audio_file_too_large: 'This file is larger than 40 MB.',
      audio_duration_too_long: 'Songs must be six minutes or shorter.',
      audio_duration_too_short: 'Choose a song at least three seconds long.',
      audio_codec_unsupported: 'This audio format is not supported. Try MP3, WAV, M4A, or AAC.',
      audio_decode_failed: 'The audio could not be decoded. The file may be damaged or use an unsupported codec.',
    };
    if (messages[error.reason]) return messages[error.reason];
  }
  if (error instanceof Error) {
    if (error.message.includes('40')) return 'This file is larger than 40 MB.';
    if (error.message.includes('duration') || error.message.includes('360')) return 'Songs must be six minutes or shorter.';
    if (error.message.includes('format') || error.message.includes('decode') || error.message.includes('codec')) return 'This audio format could not be read. Try MP3, WAV, M4A, or AAC.';
  }
  return fallback;
}

export default function App({ testSongs }: { testSongs?: Song[] } = {}) {
  const [view, setView] = useState<View>('library');
  const [progress, setProgress] = useState<Progress>(() => testSongs ? { ...EMPTY_PROGRESS, settings: { ...DEFAULT_SETTINGS }, tutorialComplete: true, gameplayVersion: 'line-v3' } : safeLoadProgress());
  const [importedSongs, setImportedSongs] = useState<Song[]>([]);
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [selectedAnalysis, setSelectedAnalysis] = useState<BeatAnalysis>();
  const [selectedCharts, setSelectedCharts] = useState<Partial<Record<Difficulty, Chart>>>({});
  const [activeRun, setActiveRun] = useState<{ song: Song; chart: Chart; config: RunConfig } | null>(null);
  const [lastConfig, setLastConfig] = useState<RunConfig | null>(null);
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [lastWasBest, setLastWasBest] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [secretHearts, setSecretHearts] = useState(0);
  const [showSecret, setShowSecret] = useState(false);
  const importController = useRef<AbortController | null>(null);
  const selectionRequest = useRef(0);
  const crownTapCount = useRef(0);
  const songs = useMemo(() => testSongs ?? [...BUNDLED_SONGS, ...importedSongs], [importedSongs, testSongs]);
  const rankedHistory = useMemo(() => [...(progress.rankedRecords ?? []), ...progress.results], [progress.rankedRecords, progress.results]);

  useEffect(() => {
    if (testSongs) return;
    let active = true;
    listImportedSongs().then((items) => { if (active) setImportedSongs(items); }).catch((error: unknown) => {
      reportDiagnostic(error, { operation: 'imported_song_list', reason: 'local_library_unavailable', fallback: 'bundled_catalog' });
      if (active) setImportError('Your imported songs could not be loaded. Your bundled collection is still ready.');
    });
    return () => { active = false; importController.current?.abort(); };
  }, []);

  useEffect(() => {
    const handleWarning = (event: Event) => setStorageWarning((event as CustomEvent<string>).detail || 'Progress could not be saved on this device.');
    window.addEventListener('afterbeat:storage-warning', handleWarning);
    return () => window.removeEventListener('afterbeat:storage-warning', handleWarning);
  }, []);

  function persist(next: Progress) {
    const retained = { ...next, results: next.results.slice(-200), rankedRecords: compactRankedResults([...(next.rankedRecords ?? []), ...next.results]) };
    setProgress(retained);
    if (testSongs) return;
    try { saveProgress(retained); }
    catch (error) {
      reportDiagnostic(error, { operation: 'progress_save', reason: 'local_progress_save_failed', retryable: true });
      setScreenError('Progress could not be saved on this device.');
    }
  }

  async function selectSong(song: Song) {
    const requestId = ++selectionRequest.current;
    setSelectedSong(song); setSelectedAnalysis(undefined); setSelectedCharts({}); setScreenError(null); setView('details');
    try {
      const analysis = testSongs && song.analysis ? song.analysis : await getSongAnalysis(song);
      // Regeneration is deterministic and also upgrades authored arrangement revisions.
      const charts = testSongs && song.charts ? song.charts : generateCharts(analysis);
      if (requestId === selectionRequest.current) {
        const prepared={...song,bpm:analysis.bpm,durationMs:analysis.durationMs,analysis,charts};
        setSelectedSong(prepared);setSelectedAnalysis(analysis);setSelectedCharts(charts);
        if(song.source==='import')setImportedSongs(current=>current.map(item=>item.id===song.id?prepared:item));
      }
    } catch (error) {
      reportDiagnostic(error, { operation: 'song_analysis_load', reason: 'chart_preflight_failed', retryable: true });
      if (requestId === selectionRequest.current) setScreenError('The chart scan could not be prepared. You can retry by choosing the song again.');
    }
  }

  async function startRun(song: Song, config: RunConfig) {
    if (!config.practice && !isDifficultyUnlocked(rankedHistory, song.id, config.difficulty)) {
      setSelectedSong(song); setScreenError('Earn one star on the previous difficulty to unlock this stage, or try it in practice.'); setView('details');
      return;
    }
    setPreparing(true); setScreenError(null);
    try {
      const analysis = testSongs && song.analysis ? song.analysis : selectedSong?.id === song.id && isCurrentAnalysis(selectedAnalysis) ? selectedAnalysis : await getSongAnalysis(song);
      const charts = testSongs && song.charts ? song.charts : selectedSong?.id === song.id && selectedCharts[config.difficulty]?.version===CHART_VERSION && selectedCharts[config.difficulty]?.audioHash===analysis.audioHash ? selectedCharts : generateCharts(analysis);
      const chart = charts[config.difficulty];
      if (!chart) throw new Error('requested_chart_unavailable');
      setSelectedSong(song); setSelectedAnalysis(analysis); setSelectedCharts(charts); setLastConfig(config); setActiveRun({ song, chart, config }); setView('game');
    } catch (error) {
      reportDiagnostic(error, { operation: 'game_prepare', reason: 'chart_prepare_failed', retryable: true });
      setScreenError('The stage could not be prepared. Your audio and progress are unchanged.');
      if (view === 'library') { setSelectedSong(song); setView('details'); }
    } finally { setPreparing(false); }
  }

  async function handleImport(file: File) {
    importController.current?.abort();
    const controller = new AbortController(); importController.current = controller;
    setImportError(null); setImportProgress(0);
    try {
      const song = await importSong(file, { signal: controller.signal, onProgress: (value) => setImportProgress(value * 100) });
      setImportedSongs((current) => [song, ...current.filter((item) => item.id !== song.id)]);
      setImportProgress(null); await selectSong(song);
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      reportDiagnostic(error, { operation: 'song_import', reason: cancelled ? 'operation_cancelled' : 'song_import_failed', retryable: !cancelled, fallback: 'library_unchanged' });
      setImportProgress(null); setImportError(readableError(error, 'This song could not be imported. Try another audio file.'));
    } finally { if (importController.current === controller) importController.current = null; }
  }

  async function handleDelete(song: Song) {
    if (!window.confirm(`Remove “${song.title}” and its local audio from this device?`)) return;
    try {
      await deleteImportedSong(song.id);
      setImportedSongs((current) => current.filter((item) => item.id !== song.id));
    } catch (error) {
      reportDiagnostic(error, { operation: 'song_delete', reason: 'local_song_delete_failed', retryable: true });
      setImportError('The imported song could not be removed.');
    }
  }

  function toggleFavorite(song: Song) {
    const exists = progress.favorites.includes(song.id);
    persist({ ...progress, favorites: exists ? progress.favorites.filter((id) => id !== song.id) : [...progress.favorites, song.id] });
  }

  async function repairSelected(bpm: number, firstBeatMs: number) {
    if (!selectedSong) return;
    setScreenError(null);
    try {
      const repaired = await repairSongAnalysis(selectedSong, bpm, firstBeatMs);
      const analysis = repaired.analysis ?? await getSongAnalysis(repaired);
      const charts = generateCharts(analysis);
      setSelectedSong(repaired); setSelectedAnalysis(analysis); setSelectedCharts(charts);
      if (repaired.source === 'import') setImportedSongs((current) => current.map((song) => song.id === repaired.id ? repaired : song));
    } catch (error) {
      reportDiagnostic(error, { operation: 'song_analysis_repair', reason: 'beat_correction_failed', retryable: true });
      setScreenError('The corrected beat map could not be saved. Try another BPM or first-beat position.');
    }
  }

  function finishRun(result: RunResult) {
    const previousBest = leaderboardFor(rankedHistory, result.songId, result.difficulty, result.rate, result.chartId)[0]?.score ?? -1;
    const isBest = !result.practice && result.completed && result.score > 0 && result.score > previousBest;
    const next: Progress = { ...progress, results: [...progress.results, result], lastPlayed: { ...progress.lastPlayed, [result.songId]: result.createdAt }, tutorialComplete: true, gameplayVersion: 'line-v3' };
    persist(next); setLastWasBest(isBest); setLastResult(result); setActiveRun(null); setView('results');
  }

  function updateSettings(settings: Settings) { persist({ ...progress, settings }); }
  function playNextDifficulty() {
    if (!lastResult || !selectedSong || starsForResult(lastResult) < 1) return;
    const difficulty = nextDifficulty(lastResult.difficulty);
    if (difficulty) void startRun(selectedSong, { difficulty, rate: lastResult.rate, practice: false, startMs: 0, loop: false });
  }
  function goLibrary() { setScreenError(null); setView('library'); }
  function tapWordmark() {
    goLibrary();
    crownTapCount.current += 1;
    if (crownTapCount.current < 5) return;
    crownTapCount.current = 0;
    setSecretHearts((hearts) => hearts + 1);
    setShowSecret(true);
  }

  const showChrome = view !== 'game';
  return (
    <div className="app-shell">
      {testSongs && <div className="visual-test-banner">Visual test · synthetic piano · progress not saved</div>}
      {storageWarning && <div className="storage-warning" role="alert"><span>{storageWarning}</span><button onClick={() => setStorageWarning(null)}>Dismiss</button></div>}
      <div className={`device-frame${view === 'game' ? ' device-frame--game' : ''}`}>
        {showChrome && <header className="brand-bar">
          <button className="brand" onClick={tapWordmark} aria-label="SusikaQueenPiano home"><img src="/brand/mark.svg" alt="" /><strong>Susika<span>Queen</span><em>Piano</em></strong>{secretHearts > 0 && <span className="secret-heart" aria-label={`${secretHearts} secret ${secretHearts === 1 ? 'heart' : 'hearts'}`}>♥ {secretHearts}</span>}</button>
          <nav className="brand-bar__actions" aria-label="Main navigation">
            <button onClick={() => setView('library')} aria-label="Song library" aria-current={view === 'library' ? 'page' : undefined}><Home aria-hidden="true" /></button>
            <button onClick={() => setView('journey')} aria-label="Mastery journey" aria-current={view === 'journey' ? 'page' : undefined}><BookOpen aria-hidden="true" /></button>
            <button onClick={() => setView('settings')} aria-label="Settings" aria-current={view === 'settings' ? 'page' : undefined}><SettingsIcon aria-hidden="true" /></button>
          </nav>
        </header>}
        <main className={`app-main${view === 'game' ? ' app-main--game' : ''}`}>
          {view === 'library' && <Library songs={songs} progress={{ ...progress, results: rankedHistory }} busy={preparing || importProgress != null} importProgress={importProgress} importError={importError} onChoose={(song) => void selectSong(song)} onQuickPlay={(song) => void startRun(song, { difficulty: recommendedDifficulty(rankedHistory, song.id), rate: 1, practice: false, startMs: 0, loop: false })} onToggleFavorite={toggleFavorite} onImport={(file) => void handleImport(file)} onCancelImport={() => importController.current?.abort()} onDeleteImport={(song) => void handleDelete(song)} />}
          {view === 'details' && selectedSong && <SongDetails key={selectedSong.id} song={selectedSong} analysis={selectedAnalysis} charts={selectedCharts} results={rankedHistory} favorite={progress.favorites.includes(selectedSong.id)} preparing={preparing} error={screenError} onBack={goLibrary} onToggleFavorite={() => toggleFavorite(selectedSong)} onStart={(config) => void startRun(selectedSong, config)} onRepair={repairSelected} />}
          {view === 'game' && activeRun && <Suspense fallback={<div className="loading-screen"><LoaderCircle className="spin" aria-hidden="true" /><span>Raising the curtain…</span></div>}><GameStage song={activeRun.song} chart={activeRun.chart} config={activeRun.config} settings={progress.settings} tutorial={!progress.tutorialComplete || progress.gameplayVersion !== 'line-v3'} onTutorialComplete={()=>persist({...progress,tutorialComplete:true,gameplayVersion:'line-v3'})} onFinish={finishRun} onExit={() => { setActiveRun(null); setView('details'); }} /></Suspense>}
          {view === 'results' && lastResult && <><Results result={lastResult} results={rankedHistory} songTitle={selectedSong?.title} personalBest={lastWasBest} onNextDifficulty={playNextDifficulty} onRetry={() => selectedSong && lastConfig && void startRun(selectedSong, lastConfig)} onChooseSong={goLibrary} />{lastResult.completed && <aside className="queen-dedication" aria-label="A special dedication"><span aria-hidden="true">♥</span><div><strong>For my rhythm queen</strong><p>You make every song feel like ours.</p></div></aside>}</>}
          {view === 'settings' && <SettingsPanel settings={progress.settings} skins={unlockedSkins(rankedHistory)} onChange={updateSettings} onCalibration={() => setView('calibration')} onBack={goLibrary} />}
          {view === 'calibration' && <Calibration value={progress.settings.calibrationMs} onSave={(calibrationMs) => { updateSettings({ ...progress.settings, calibrationMs }); setView('settings'); }} onBack={() => setView('settings')} />}
          {view === 'journey' && <MasteryJourney progress={{ ...progress, results: rankedHistory }} onBack={goLibrary} onPlay={goLibrary} />}
        </main>
        {showSecret && <div className="secret-note" role="status" aria-live="polite"><span aria-hidden="true">♥</span><p><strong>A tiny encore, just for you.</strong> Five crown taps found one hidden heart.</p><button onClick={() => setShowSecret(false)} aria-label="Close secret message">×</button></div>}
      </div>
    </div>
  );
}
