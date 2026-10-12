import { Clock3, Heart, Import, Music2, Play, Search, Sparkles, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { Progress, Song } from '../types';
import { SongArtwork } from './SongArtwork';

export type LibraryFilter = 'featured' | 'all' | 'favorites' | 'recent' | 'imported';
type SortMode = 'collection' | 'title';

interface LibraryProps {
  songs: Song[];
  progress: Progress;
  busy?: boolean;
  importProgress?: number | null;
  importError?: string | null;
  onChoose: (song: Song) => void;
  onQuickPlay: (song: Song) => void;
  onToggleFavorite: (song: Song) => void;
  onImport: (file: File) => void;
  onCancelImport: () => void;
  onDeleteImport: (song: Song) => void;
}

const FILTERS: Array<{ id: LibraryFilter; label: string }> = [
  { id: 'featured', label: 'Featured' },
  { id: 'all', label: 'All songs' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'recent', label: 'Recent' },
  { id: 'imported', label: 'On this device' },
];

function compareCollectionOrder(a: Song, b: Song) {
  return (a.featuredOrder ?? Number.MAX_SAFE_INTEGER) - (b.featuredOrder ?? Number.MAX_SAFE_INTEGER)
    || (a.addedAt ?? 0) - (b.addedAt ?? 0)
    || a.title.localeCompare(b.title)
    || a.artist.localeCompare(b.artist);
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function collectionSortLabel(filter: LibraryFilter, searching: boolean) {
  if (searching || filter === 'all' || filter === 'favorites') return 'Collection order';
  if (filter === 'featured') return 'Curated order';
  if (filter === 'recent') return 'Recently played';
  return 'Recently added';
}

export function Library({ songs, progress, busy, importProgress, importError, onChoose, onQuickPlay, onToggleFavorite, onImport, onCancelImport, onDeleteImport }: LibraryProps) {
  const [filter, setFilter] = useState<LibraryFilter>('featured');
  const [genre, setGenre] = useState<string>('All genres');
  const [sortMode, setSortMode] = useState<SortMode>('collection');
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const favoriteIds = useMemo(() => new Set(progress.favorites), [progress.favorites]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searching = normalizedQuery.length > 0;

  const genreOptions = useMemo(() => {
    return [...new Set(songs.map((song) => song.genre).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  }, [songs]);

  const visibleSongs = useMemo(() => {
    // A typed search always spans the complete catalogue so the Featured tab
    // never hides a valid match. Collection filters resume when it is cleared.
    let next = searching
      ? songs.filter((song) => `${song.title} ${song.artist} ${song.genre}`.toLocaleLowerCase().includes(normalizedQuery))
      : songs.filter((song) => {
        if (filter === 'featured') return song.featuredOrder != null;
        if (filter === 'favorites') return favoriteIds.has(song.id);
        if (filter === 'recent') return Boolean(progress.lastPlayed[song.id]);
        if (filter === 'imported') return song.source === 'import';
        return true;
      });

    if (genre !== 'All genres') next = next.filter((song) => song.genre === genre);

    return [...next].sort((a, b) => {
      if (sortMode === 'title') return a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist);
      if (!searching && filter === 'featured') return (a.featuredOrder ?? Number.MAX_SAFE_INTEGER) - (b.featuredOrder ?? Number.MAX_SAFE_INTEGER);
      if (!searching && filter === 'recent') return progress.lastPlayed[b.id] - progress.lastPlayed[a.id];
      if (!searching && filter === 'imported') return (b.addedAt ?? 0) - (a.addedAt ?? 0) || a.title.localeCompare(b.title);
      return compareCollectionOrder(a, b);
    });
  }, [favoriteIds, filter, genre, normalizedQuery, progress.lastPlayed, searching, songs, sortMode]);

  const heroSong = !searching && filter === 'featured' ? visibleSongs[0] : undefined;
  const listSongs = heroSong ? visibleSongs.slice(1) : visibleSongs;
  const activeSortLabel = sortMode === 'title' ? 'Title A–Z' : collectionSortLabel(filter, searching);

  function selectFilter(nextFilter: LibraryFilter) {
    setFilter(nextFilter);
    setGenre('All genres');
    setSortMode('collection');
    setQuery('');
  }

  function clearSearch() {
    setQuery('');
  }

  return (
    <section className="library library--catalog" aria-labelledby="library-title">
      <header className="library-catalog__header">
        <div>
          <p className="eyebrow">Free music collection <span aria-hidden="true">•</span> CC BY 4.0</p>
          <h1 id="library-title">Find your next favorite.</h1>
          <p>A playful mix of Kevin MacLeod tracks, ready for piano-tile play.</p>
        </div>
        <div className="library-catalog__total" aria-label={`${songs.length} songs in your library`}>
          <strong>{songs.length}</strong>
          <span>songs</span>
        </div>
      </header>

      <div className="library__tools library-catalog__tools">
        <label className="search-field">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search the full song catalogue</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search songs, artists, or genres" />
          {query && <button type="button" onClick={clearSearch} aria-label="Clear search">×</button>}
        </label>
        <button className="icon-button import-button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Import a song from this device">
          <Import size={19} aria-hidden="true" />
          <span>Import song</span>
        </button>
        <input ref={fileRef} className="sr-only" type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/wav,.mp3,.m4a,.aac,.wav" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onImport(file);
          event.currentTarget.value = '';
        }} />
      </div>

      {importProgress != null && (
        <div className="scan-status" role="status" aria-live="polite">
          <div>
            <span>Listening for beats</span><strong>{Math.round(importProgress)}%</strong>
          </div>
          <progress value={importProgress} max={100}>{importProgress}%</progress>
          <button className="text-button" onClick={onCancelImport}>Cancel scan</button>
        </div>
      )}
      {importError && <p className="inline-error" role="alert">{importError}</p>}

      <nav className="filter-tabs library-catalog__tabs" aria-label="Song collections">
        {FILTERS.map((item) => (
          <button key={item.id} type="button" aria-current={!searching && filter === item.id ? 'page' : undefined} onClick={() => selectFilter(item.id)}>{item.label}</button>
        ))}
      </nav>

      <div className="genre-filter" aria-label="Filter songs by genre">
        <button type="button" className={genre === 'All genres' ? 'is-active' : ''} aria-pressed={genre === 'All genres'} onClick={() => setGenre('All genres')}>All genres</button>
        {genreOptions.map((item) => (
          <button type="button" key={item} className={genre === item ? 'is-active' : ''} aria-pressed={genre === item} onClick={() => setGenre(item)}>{item}</button>
        ))}
      </div>

      {heroSong && (
        <article className="featured-hero" style={{ '--featured-color': heroSong.color } as React.CSSProperties}>
          <SongArtwork song={heroSong} size="hero" />
          <div className="featured-hero__copy">
            <span className="featured-hero__label"><Sparkles size={14} aria-hidden="true" /> Featured pick</span>
            <h2>{heroSong.title}</h2>
            <p>{heroSong.artist}</p>
            <div className="featured-hero__facts">
              <span>{heroSong.genre}</span>
              <span>{formatDuration(heroSong.durationMs)}</span>
            </div>
          </div>
          <div className="featured-hero__actions">
            <button className="featured-hero__play" onClick={() => onQuickPlay(heroSong)} disabled={busy}>
              <Play size={18} fill="currentColor" aria-hidden="true" /> Quick play
            </button>
            <button className="featured-hero__details" onClick={() => onChoose(heroSong)}>Choose difficulty</button>
            <button className={`featured-hero__favorite${favoriteIds.has(heroSong.id) ? ' is-active' : ''}`} onClick={() => onToggleFavorite(heroSong)} aria-label={`${favoriteIds.has(heroSong.id) ? 'Remove' : 'Add'} ${heroSong.title} ${favoriteIds.has(heroSong.id) ? 'from' : 'to'} favorites`} aria-pressed={favoriteIds.has(heroSong.id)}>
              <Heart size={19} fill={favoriteIds.has(heroSong.id) ? 'currentColor' : 'none'} aria-hidden="true" />
            </button>
          </div>
        </article>
      )}

      <div className="library-catalog__list-heading">
        <div>
          <h2>{searching ? 'Search results' : FILTERS.find((item) => item.id === filter)?.label}</h2>
          <span aria-live="polite">{visibleSongs.length} {visibleSongs.length === 1 ? 'song' : 'songs'}{genre !== 'All genres' ? ` in ${genre}` : ''}</span>
        </div>
        <button type="button" className="sort-button" onClick={() => setSortMode((current) => current === 'collection' ? 'title' : 'collection')} aria-label={`Sort songs by ${sortMode === 'collection' ? 'title' : collectionSortLabel(filter, searching)}`}>
          Sort: <strong>{activeSortLabel}</strong>
        </button>
      </div>

      <div className="song-list library-catalog__list" aria-live="polite">
        {listSongs.map((song, index) => {
          const best = progress.results.filter((result) => result.songId === song.id && result.completed && !result.practice).sort((a, b) => b.score - a.score)[0];
          const position = index + (heroSong ? 2 : 1);
          return (
            <article className="song-row" key={song.id}>
              <button className="song-row__main" onClick={() => onChoose(song)}>
                <span className="song-row__number" aria-label={`Song ${position}`}>{position}</span>
                <SongArtwork song={song} size="compact" />
                <span className="song-row__copy">
                  <strong>{song.title}</strong>
                  <span>{song.artist} <i aria-hidden="true">•</i> {song.genre}</span>
                </span>
                <span className="song-row__meta">
                  {best ? <><b>{best.score.toLocaleString()}</b><small>best</small></> : <><b>{formatDuration(song.durationMs)}</b><small>length</small></>}
                </span>
              </button>
              <button className={`row-action${favoriteIds.has(song.id) ? ' is-active' : ''}`} onClick={() => onToggleFavorite(song)} aria-label={`${favoriteIds.has(song.id) ? 'Remove' : 'Add'} ${song.title} ${favoriteIds.has(song.id) ? 'from' : 'to'} favorites`} aria-pressed={favoriteIds.has(song.id)}>
                <Heart size={19} fill={favoriteIds.has(song.id) ? 'currentColor' : 'none'} aria-hidden="true" />
              </button>
              {song.source === 'import' && (
                <button className="row-action row-action--danger" onClick={() => onDeleteImport(song)} aria-label={`Delete imported song ${song.title}`}>
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              )}
            </article>
          );
        })}
        {!visibleSongs.length && (
          <div className="empty-state">
            {filter === 'recent' && !searching ? <Clock3 aria-hidden="true" /> : <Music2 aria-hidden="true" />}
            <strong>{searching ? 'No matching songs' : genre !== 'All genres' ? `No ${genre} songs here` : 'No songs here yet'}</strong>
            <p>{filter === 'imported' && !searching ? 'Import an audio file to build your private, on-device collection.' : searching ? 'Try another title, artist, or genre.' : 'Choose another collection or genre.'}</p>
            {(searching || genre !== 'All genres') && <button type="button" className="empty-state__reset" onClick={() => { clearSearch(); setGenre('All genres'); }}>Show this collection</button>}
          </div>
        )}
      </div>

      <p className="privacy-note"><span aria-hidden="true">●</span> Imported audio and analysis stay private on this device. <a href="/licenses/attribution.txt">Music credits</a></p>
    </section>
  );
}
