import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Progress, type Song } from '../types';
import { Library } from './Library';

const progress: Progress = {
  version: 1,
  results: [],
  favorites: [],
  lastPlayed: {},
  settings: DEFAULT_SETTINGS,
  tutorialComplete: true,
};

const songs: Song[] = [
  { id: 'second', title: 'Second Song', artist: 'Kevin MacLeod', genre: 'Piano', durationMs: 62_000, bpm: 100, color: '#222', source: 'bundled', featuredOrder: 2, rank: 99 },
  { id: 'first', title: 'First Song', artist: 'Kevin MacLeod', genre: 'Comedy', durationMs: 61_000, bpm: 100, color: '#111', source: 'bundled', featuredOrder: 1, rank: 1 },
  { id: 'import', title: 'My Import', artist: 'Your music', genre: 'Imported', durationMs: 60_000, bpm: 100, color: '#333', source: 'import', addedAt: 1 },
];

function renderLibrary() {
  return renderToStaticMarkup(
    <Library
      songs={songs}
      progress={progress}
      onChoose={() => {}}
      onQuickPlay={() => {}}
      onToggleFavorite={() => {}}
      onImport={() => {}}
      onCancelImport={() => {}}
      onDeleteImport={() => {}}
    />,
  );
}

describe('Library', () => {
  it('presents the free collection without chart ranking language', () => {
    const html = renderLibrary();

    expect(html).toContain('Free music collection');
    expect(html).toContain('CC BY 4.0');
    expect(html).not.toContain('Billboard');
    expect(html).not.toContain('#99');
    expect(html).not.toContain('>—<');
  });

  it('shows every catalogue genre including imported music', () => {
    const html = renderLibrary();

    expect(html).toContain('>Comedy</button>');
    expect(html).toContain('>Piano</button>');
    expect(html).toContain('>Imported</button>');
  });

  it('uses collection positions and links to the music attribution', () => {
    const html = renderLibrary();

    expect(html).toContain('aria-label="Song 2"');
    expect(html).toContain('href="/licenses/attribution.txt"');
    expect(html).toContain('Music credits');
  });
});
