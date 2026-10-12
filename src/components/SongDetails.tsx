import { AlertTriangle, ArrowLeft, Gauge, Heart, Lock, Pause, Play, RotateCcw, SlidersHorizontal, TimerReset } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadSongUrl } from '../services/storage';
import { reportDiagnostic } from '../services/diagnostics';
import type { BeatAnalysis, Chart, Difficulty, PlaybackRate, RunConfig, RunResult, Song } from '../types';
import { bestStars, isDifficultyUnlocked, recommendedDifficulty } from '../services/progression';
import { Stars } from './Stars';
import { Leaderboard } from './Leaderboard';
import { SCORING_VERSION } from '../rhythm/judgement';
import { DIFFICULTIES, RATES } from '../types';
import { SongArtwork } from './SongArtwork';

interface SongDetailsProps {
  song: Song;
  analysis?: BeatAnalysis;
  charts: Partial<Record<Difficulty, Chart>>;
  favorite: boolean;
  results: RunResult[];
  preparing?: boolean;
  error?: string | null;
  onBack: () => void;
  onToggleFavorite: () => void;
  onStart: (config: RunConfig) => void;
  onRepair: (bpm: number, firstBeatMs: number) => Promise<void>;
}

function formatTime(milliseconds: number) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function SongDetails({ song, analysis, charts, favorite, results, preparing, error, onBack, onToggleFavorite, onStart, onRepair }: SongDetailsProps) {
  const [difficulty, setDifficulty] = useState<Difficulty>(() => recommendedDifficulty(results, song.id));
  const [rate, setRate] = useState<PlaybackRate>(1);
  const [practice, setPractice] = useState(false);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(Math.floor(song.durationMs / 1000));
  const [loop, setLoop] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [repairBpm, setRepairBpm] = useState(song.bpm);
  const [firstBeatMs, setFirstBeatMs] = useState(analysis?.beatsMs[0] ?? 0);
  const [taps, setTaps] = useState<number[]>([]);
  const [repairing, setRepairing] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let active = true;
    setAudioUrl(null); setPreviewError(null); setPreviewing(false);
    loadSongUrl(song).then((url) => active && setAudioUrl(url)).catch((loadError: unknown) => {
      reportDiagnostic(loadError, { operation: 'song_preview', reason: 'audio_url_unavailable' });
      if (active) setPreviewError('The audio preview is unavailable on this device.');
    });
    return () => { active = false; audioRef.current?.pause(); };
  }, [song]);

  useEffect(() => {
    setRepairBpm(analysis?.bpm ?? song.bpm);
    setFirstBeatMs(analysis?.beatsMs[0] ?? 0);
    setTaps([]);
  }, [analysis?.version, song.bpm, song.id]);

  const chart = charts[difficulty];
  const unlocked = isDifficultyUnlocked(results, song.id, difficulty);
  const reviewedDemo = song.source === 'demo' && analysis?.warnings.includes('source_assisted_tempo_reviewed') && !analysis.warnings.includes('phase_uncertain');
  const unresolvedWarnings = analysis?.warnings.filter((warning) => warning !== 'manually_aligned') ?? [];
  const lowConfidence = !reviewedDemo && Boolean(analysis && (analysis.confidence < 0.62 || unresolvedWarnings.length));
  const tapBpm = useMemo(() => {
    if (taps.length < 2) return null;
    const intervals = taps.slice(1).map((tap, index) => tap - taps[index]);
    return Math.round(60000 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length));
  }, [taps]);

  function tapTempo() {
    const now = performance.now();
    const recent = taps.filter((tap) => now - tap < 3000);
    setTaps([...recent, now].slice(-8));
  }

  async function applyRepair(nextBpm = repairBpm) {
    setRepairing(true);
    try {
      await onRepair(Math.max(40, Math.min(240, nextBpm)), Math.max(0, firstBeatMs));
    } finally {
      setRepairing(false);
    }
  }

  async function togglePreview() {
    if (!audioRef.current) return;
    try {
      if (previewing) audioRef.current.pause();
      else await audioRef.current.play();
      setPreviewing(!previewing);
    } catch (previewError) {
      reportDiagnostic(previewError, { operation: 'song_preview', reason: 'playback_failed' });
      setPreviewError('Playback could not start. Check this device’s audio output and try again.');
    }
  }

  return (
    <section className="song-details" aria-labelledby="song-title">
      <header className="detail-bar">
        <button className="icon-button" onClick={onBack} aria-label="Back to library"><ArrowLeft aria-hidden="true" /></button>
        <span>Song setup</span>
        <button className={`icon-button${favorite ? ' is-active' : ''}`} onClick={onToggleFavorite} aria-label={`${favorite ? 'Remove from' : 'Add to'} favorites`}><Heart fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" /></button>
      </header>

      <div className="song-hero">
        <SongArtwork song={song} size="hero" playing={previewing} />
        <div className="song-hero__copy">
          <p className="eyebrow">{song.source === 'import' ? 'On this device' : 'Chosen for SusikaQueenPiano'}</p>
          <h1 id="song-title">{song.title}</h1>
          <p>{song.artist}</p>
          <div className="song-facts"><span>{song.genre}</span><span>{Math.round(song.bpm)} BPM</span><span>{formatTime(song.durationMs)}</span></div>
          <button className="preview-button" onClick={togglePreview} disabled={!audioUrl}>
            {previewing ? <Pause fill="currentColor" aria-hidden="true" /> : <Play fill="currentColor" aria-hidden="true" />}
            {previewing ? 'Pause preview' : audioUrl ? 'Preview song' : 'Loading audio…'}
          </button>
          {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" onEnded={() => setPreviewing(false)} />}
          {previewError && <p className="preview-error" role="alert">{previewError}</p>}
        </div>
      </div>

      <div className="setup-section">
        <div className="section-heading"><div><p className="eyebrow">Chart</p><h2>Difficulty</h2></div>{chart && <span className="rating-pill">Lv. {chart.rating}</span>}</div>
        <div className="segmented" role="radiogroup" aria-label="Difficulty">
          {DIFFICULTIES.map((item) => <button key={item} className="difficulty-choice" role="radio" aria-checked={difficulty === item} aria-label={`${item}${!practice && !isDifficultyUnlocked(results, song.id, item) ? ' locked' : ''}`} disabled={!practice && !isDifficultyUnlocked(results, song.id, item)} onClick={() => setDifficulty(item)}><span>{item}{!practice && !isDifficultyUnlocked(results, song.id, item) && <Lock size={12} aria-hidden="true" />}</span><Stars count={bestStars(results, song.id, item)} /></button>)}
        </div>
        <p className="difficulty-hint">One star unlocks the next stage. Easy → Normal → Hard → Expert.<br />★ 50% · ★★ 75% · ★★★ 90% · Practice any stage freely.</p>
        {chart ? (
          <dl className="chart-stats">
            <div><dt>Notes</dt><dd>{chart.notes.length}</dd></div>
            <div><dt>Length</dt><dd>{formatTime(chart.durationMs)}</dd></div>
            <div><dt>Style</dt><dd>Piano tiles</dd></div>
          </dl>
        ) : <p className="muted-copy">Chart details appear after the song scan.</p>}
      </div>

      <div className="setup-section setup-section--split">
        <div><p className="eyebrow">Tempo</p><h2>Playback speed</h2></div>
        <div className="segmented segmented--compact" role="radiogroup" aria-label="Playback speed">
          {RATES.map((item) => <button key={item} role="radio" aria-checked={rate === item} onClick={() => setRate(item)}>{item}×</button>)}
        </div>
      </div>

      <div className="setup-section practice-panel">
        <label className="switch-row">
          <span><SlidersHorizontal aria-hidden="true" /><span><strong>Practice section</strong><small>Practice runs never affect rankings or personal bests.</small></span></span>
          <input type="checkbox" checked={practice} onChange={(event) => { setPractice(event.target.checked); if (!event.target.checked && !unlocked) setDifficulty(recommendedDifficulty(results, song.id)); }} />
        </label>
        {practice && <div className="practice-controls">
          <label>Start <input type="number" min={0} max={endSec - 1} value={startSec} onChange={(event) => setStartSec(Number(event.target.value))} /><span>sec</span></label>
          <label>End <input type="number" min={startSec + 1} max={Math.floor(song.durationMs / 1000)} value={endSec} onChange={(event) => setEndSec(Number(event.target.value))} /><span>sec</span></label>
          <label className="loop-control"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} /><RotateCcw size={16} aria-hidden="true" /> Loop section</label>
        </div>}
      </div>

      {lowConfidence && <div className="analysis-warning">
        <div className="warning-title"><AlertTriangle aria-hidden="true" /><div><strong>Optional pulse adjustment</strong><p>The overall tempo was less certain. Tiles follow detected sounds, so you can play now or adjust the pulse after a preview.</p></div></div>
        <div className="repair-grid">
          <label>BPM <input type="number" min={40} max={240} step="0.1" value={repairBpm} onChange={(event) => setRepairBpm(Number(event.target.value))} /></label>
          <div className="repair-actions"><button onClick={() => setRepairBpm((value) => value / 2)} aria-label="Halve BPM">½</button><button onClick={() => setRepairBpm((value) => value * 2)} aria-label="Double BPM">2×</button></div>
          <label>First beat <span><input type="number" min={0} max={song.durationMs} value={firstBeatMs} onChange={(event) => setFirstBeatMs(Number(event.target.value))} /><small>ms</small></span></label>
          <button className="tap-tempo" onClick={tapTempo}><TimerReset aria-hidden="true" /> Tap tempo {tapBpm ? <strong>{tapBpm} BPM</strong> : <small>4+ taps</small>}</button>
        </div>
        <button className="secondary-button" onClick={() => { const nextBpm = tapBpm ?? repairBpm; setRepairBpm(nextBpm); void applyRepair(nextBpm); }} disabled={repairing}>{repairing ? 'Rebuilding chart…' : 'Apply correction & rebuild'}</button>
      </div>}

      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="primary-button start-button" onClick={() => {
        const maxSeconds = Math.max(1, Math.floor(song.durationMs / 1000));
        const safeStart = Math.max(0, Math.min(startSec, maxSeconds - 1));
        const safeEnd = Math.max(safeStart + 1, Math.min(endSec, maxSeconds));
        onStart({ difficulty, rate, practice, startMs: practice ? safeStart * 1000 : 0, endMs: practice ? safeEnd * 1000 : undefined, loop: practice && loop });
      }} disabled={preparing || repairing || !chart?.notes.length || (!practice && !unlocked)}>
        {preparing ? <><Gauge className="spin" aria-hidden="true" /> Preparing the stage…</> : !chart ? 'Scanning your song…' : !chart.notes.length ? 'No playable sounds found' : <><Play fill="currentColor" aria-hidden="true" /> Start performance</>}
      </button>
      <Leaderboard results={results} songId={song.id} difficulty={difficulty} rate={rate} chartId={chart ? `${SCORING_VERSION}:${chart.id}` : undefined} />
    </section>
  );
}
