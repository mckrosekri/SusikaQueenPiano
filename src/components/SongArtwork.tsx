import { Disc3, Music2, Waves } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Song } from '../types';

interface SongArtworkProps {
  song: Song;
  size?: 'compact' | 'regular' | 'hero';
  playing?: boolean;
}

export function SongArtwork({ song, size = 'regular', playing = false }: SongArtworkProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const artworkUrl = song.artworkUrl;

  useEffect(() => setImageFailed(false), [artworkUrl]);

  const showArtwork = Boolean(artworkUrl) && !imageFailed;

  return (
    <div
      className={`song-art song-art--${size}${playing ? ' is-playing' : ''}`}
      style={{ '--song-color': song.color } as React.CSSProperties}
      role="img"
      aria-label={`${song.title} artwork`}
    >
      {showArtwork ? (
        <img className="song-art__image" src={artworkUrl} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
      ) : (
        <>
          <div className="song-art__halo" />
          <Disc3 className="song-art__disc" aria-hidden="true" />
          <Waves className="song-art__wave" aria-hidden="true" />
          <Music2 className="song-art__note" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
