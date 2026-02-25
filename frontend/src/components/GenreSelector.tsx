import { useState, useEffect, useMemo } from 'react';
import { Genre, Keyword, Language } from '../types';

const MOOD_CATEGORY_LABELS: Record<string, string> = {
  energy: 'Energy',
  emotion: 'Emotion',
  atmosphere: 'Atmosphere',
  texture: 'Texture',
};

const MOOD_CATEGORY_ORDER = ['energy', 'emotion', 'atmosphere', 'texture'];
const FEELING_MAX_LENGTH = 200;

interface GenreSelectorProps {
  onStart: (genres: string[], keywords: string[], language: string, feeling: string) => void;
}

export function GenreSelector({ onStart }: GenreSelectorProps) {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<string>('rock');
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [feeling, setFeeling] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log('[GenreSelector] Fetching genres and keywords from /api/genres');
    fetch('/api/genres')
      .then((r) => r.json())
      .then((data: { genres: Genre[]; keywords: Keyword[]; languages: Language[] }) => {
        console.log('[GenreSelector] Loaded', data.genres.length, 'genres,', data.keywords.length, 'keywords,', data.languages.length, 'languages');
        setGenres(data.genres);
        setKeywords(data.keywords);
        setLanguages(data.languages);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[GenreSelector] Failed to load genres:', err);
        setLoading(false);
      });
  }, []);

  const keywordsByCategory = useMemo(() => {
    const grouped: Record<string, Keyword[]> = {};
    for (const kw of keywords) {
      const cat = kw.category || 'other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(kw);
    }
    return grouped;
  }, [keywords]);

  const selectGenre = (id: string) => {
    console.log('[GenreSelector] Genre selected:', id);
    setSelectedGenre(id);
  };

  const toggleKeyword = (id: string) => {
    setSelectedKeywords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStart = () => {
    const keywordList = [...selectedKeywords];
    console.log('[GenreSelector] Starting radio with:', selectedGenre, keywordList, selectedLanguage, feeling);
    onStart([selectedGenre], keywordList, selectedLanguage, feeling);
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
              className={`genre-card ${selectedGenre === g.id ? 'genre-card--selected' : ''}`}
              onClick={() => selectGenre(g.id)}
              aria-pressed={selectedGenre === g.id}
            >
              <span className="genre-card__icon">{g.icon}</span>
              <span className="genre-card__label">{g.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="selector__section">
        <h2 className="selector__section-title">Set the mood <span className="optional">(optional)</span></h2>
        {MOOD_CATEGORY_ORDER.map((cat) => {
          const items = keywordsByCategory[cat];
          if (!items || items.length === 0) return null;
          return (
            <div key={cat} className="mood-category">
              <h3 className="mood-category__label">{MOOD_CATEGORY_LABELS[cat] ?? cat}</h3>
              <div className="keyword-row">
                {items.map((k) => (
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
            </div>
          );
        })}
      </section>

      <section className="selector__section">
        <h2 className="selector__section-title">Language</h2>
        <div className="language-row">
          {languages.map((lang) => (
            <button
              key={lang.code}
              className={[
                'language-chip',
                selectedLanguage === lang.code ? 'language-chip--selected' : '',
                lang.code === 'instrumental' ? 'language-chip--instrumental' : '',
              ].join(' ').trim()}
              onClick={() => {
                console.log('[GenreSelector] Language selected:', lang.code);
                setSelectedLanguage(lang.code);
              }}
              aria-pressed={selectedLanguage === lang.code}
            >
              {lang.label}
            </button>
          ))}
        </div>
      </section>

      <section className="selector__section">
        <h2 className="selector__section-title">
          How are you feeling today? <span className="optional">(optional)</span>
        </h2>
        <div className="feeling-input-wrapper">
          <input
            type="text"
            className="feeling-input"
            placeholder="e.g. Late night coding session, need focus..."
            value={feeling}
            onChange={(e) => setFeeling(e.target.value.slice(0, FEELING_MAX_LENGTH))}
            maxLength={FEELING_MAX_LENGTH}
          />
          <span className="feeling-input__counter">
            {feeling.length}/{FEELING_MAX_LENGTH}
          </span>
        </div>
      </section>

      <div className="selector__footer">
        {selectedGenre && (
          <p className="selector__summary">
            {genres.find((g) => g.id === selectedGenre)?.label}
            {selectedKeywords.size > 0 && (
              <span className="selector__summary-keywords">
                {' '}&mdash;{' '}
                {[...selectedKeywords]
                  .map((id) => keywords.find((k) => k.id === id)?.label)
                  .filter(Boolean)
                  .join(', ')}
              </span>
            )}
            {' · '}
            <span className="selector__summary-language">
              {languages.find((l) => l.code === selectedLanguage)?.label ?? selectedLanguage}
            </span>
          </p>
        )}
        <button
          className="start-button"
          onClick={handleStart}
          disabled={!selectedGenre}
        >
          Start Radio
        </button>
      </div>
    </div>
  );
}
