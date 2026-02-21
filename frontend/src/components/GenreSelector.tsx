import { useState, useEffect } from 'react';
import { Genre, Keyword } from '../types';

interface GenreSelectorProps {
  onStart: (genres: string[], keywords: string[]) => void;
}

export function GenreSelector({ onStart }: GenreSelectorProps) {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [selectedGenres, setSelectedGenres] = useState<Set<string>>(new Set());
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log('[GenreSelector] Fetching genres and keywords from /api/genres');
    fetch('/api/genres')
      .then((r) => r.json())
      .then((data: { genres: Genre[]; keywords: Keyword[] }) => {
        console.log('[GenreSelector] Loaded', data.genres.length, 'genres,', data.keywords.length, 'keywords');
        setGenres(data.genres);
        setKeywords(data.keywords);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[GenreSelector] Failed to load genres:', err);
        setLoading(false);
      });
  }, []);

  const toggleGenre = (id: string) => {
    setSelectedGenres((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        console.log('[GenreSelector] Genre deselected:', id);
      } else {
        next.add(id);
        console.log('[GenreSelector] Genre selected:', id);
      }
      return next;
    });
  };

  const toggleKeyword = (id: string) => {
    setSelectedKeywords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleStart = () => {
    const genreList = [...selectedGenres];
    const keywordList = [...selectedKeywords];
    console.log('[GenreSelector] Starting radio with:', genreList, keywordList);
    onStart(genreList, keywordList);
  };

  if (loading) {
    return (
      <div className="selector-loading">
        <div className="spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="selector">
      <header className="selector__header">
        <div className="selector__logo">📻</div>
        <h1 className="selector__title">Generative Radio</h1>
        <p className="selector__subtitle">Local AI · Infinite Music</p>
      </header>

      <section className="selector__section">
        <h2 className="selector__section-title">Choose your genre</h2>
        <div className="genre-grid">
          {genres.map((g) => (
            <button
              key={g.id}
              className={`genre-card ${selectedGenres.has(g.id) ? 'genre-card--selected' : ''}`}
              onClick={() => toggleGenre(g.id)}
              aria-pressed={selectedGenres.has(g.id)}
            >
              <span className="genre-card__icon">{g.icon}</span>
              <span className="genre-card__label">{g.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="selector__section">
        <h2 className="selector__section-title">Set the mood <span className="optional">(optional)</span></h2>
        <div className="keyword-row">
          {keywords.map((k) => (
            <button
              key={k.id}
              className={`keyword-chip ${selectedKeywords.has(k.id) ? 'keyword-chip--selected' : ''}`}
              onClick={() => toggleKeyword(k.id)}
              aria-pressed={selectedKeywords.has(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </section>

      <div className="selector__footer">
        {selectedGenres.size > 0 && (
          <p className="selector__summary">
            {[...selectedGenres]
              .map((id) => genres.find((g) => g.id === id)?.label)
              .filter(Boolean)
              .join(' · ')}
            {selectedKeywords.size > 0 && (
              <span className="selector__summary-keywords">
                {' '}—{' '}
                {[...selectedKeywords]
                  .map((id) => keywords.find((k) => k.id === id)?.label)
                  .filter(Boolean)
                  .join(', ')}
              </span>
            )}
          </p>
        )}
        <button
          className="start-button"
          onClick={handleStart}
          disabled={selectedGenres.size === 0}
        >
          Start Radio
        </button>
      </div>
    </div>
  );
}
