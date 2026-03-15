import { useState, useEffect, useMemo } from 'react';
import { Genre, Keyword, Language } from '../types';

const MOOD_CATEGORY_LABELS: Record<string, string> = {
  emotion:    'Emotion',
  atmosphere: 'Atmosphere',
  instrument: 'Instrument',
};

const MOOD_CATEGORY_ORDER = ['emotion', 'atmosphere', 'instrument'];
const FEELING_MAX_LENGTH = 200;
const DJ_NAME_MAX_LENGTH = 50;

interface DJPanelProps {
  onSubmit: (genres: string[], keywords: string[], language: string, feeling: string, djName: string) => void;
  onClose: () => void;
}

export function DJPanel({ onSubmit, onClose }: DJPanelProps) {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedGenre, setSelectedGenre] = useState<string>('rock');
  const [isRandomGenre, setIsRandomGenre] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [randomCategories, setRandomCategories] = useState<Set<string>>(new Set());
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [feeling, setFeeling] = useState('');
  const [djName, setDjName] = useState('');
  const [nameError, setNameError] = useState(false);

  useEffect(() => {
    fetch('/api/genres')
      .then((r) => r.json())
      .then((data: { genres: Genre[]; keywords: Keyword[]; languages: Language[] }) => {
        setGenres(data.genres);
        setKeywords(data.keywords);
        setLanguages(data.languages);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[DJPanel] Failed to load genre data:', err);
        setLoading(false);
      });
  }, []);

  const keywordsByCategory = useMemo(() => {
    const grouped: Record<string, Keyword[]> = {};
    for (const kw of keywords) {
      let cat = kw.category || 'other';
      if (cat === 'energy')  cat = 'emotion';
      if (cat === 'texture') cat = 'atmosphere';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(kw);
    }
    return grouped;
  }, [keywords]);

  const selectGenre = (id: string) => {
    setIsRandomGenre(false);
    setSelectedGenre(id);
  };

  const selectRandom = () => {
    setIsRandomGenre(true);
    setSelectedGenre('');
  };

  const toggleKeyword = (id: string) => {
    const kw = keywords.find((k) => k.id === id);
    if (kw) {
      let cat = kw.category;
      if (cat === 'energy')  cat = 'emotion';
      if (cat === 'texture') cat = 'atmosphere';
      setRandomCategories((prev) => {
        if (!prev.has(cat)) return prev;
        const next = new Set(prev);
        next.delete(cat);
        return next;
      });
    }
    setSelectedKeywords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const randomizeCategory = (cat: string) => {
    setRandomCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
    const items = keywordsByCategory[cat] ?? [];
    if (items.length > 0) {
      setSelectedKeywords((prev) => {
        const next = new Set(prev);
        items.forEach((k) => next.delete(k.id));
        return next;
      });
    }
  };

  const handleSubmit = () => {
    if (!djName.trim()) {
      setNameError(true);
      return;
    }
    const keywordList = [...selectedKeywords];
    randomCategories.forEach((cat) => keywordList.push(`__random_${cat}__`));
    const genreArg = isRandomGenre ? ['__random__'] : [selectedGenre];
    onSubmit(genreArg, keywordList, selectedLanguage, feeling, djName.trim());
  };

  return (
    <div className="dj-panel-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dj-panel">
        <header className="dj-panel__header">
          <h1 className="dj-panel__title">You're the DJ!</h1>
          <p className="dj-panel__subtitle">Pick the vibe — your selections will drive the next tracks for everyone</p>
        </header>

        {loading ? (
          <div className="selector-loading">
            <div className="spinner" />
            <p>Loading...</p>
          </div>
        ) : (
          <>
            <section className="selector__section">
              <h2 className="selector__section-title">Choose your genre</h2>
              <div className="genre-row">
                {genres.map((g) => (
                  <button
                    key={g.id}
                    className={`genre-pill ${selectedGenre === g.id ? 'genre-pill--selected' : ''}`}
                    onClick={() => selectGenre(g.id)}
                    aria-pressed={selectedGenre === g.id}
                  >
                    {g.label}
                  </button>
                ))}
                <button
                  className={`genre-pill genre-pill--random ${isRandomGenre ? 'genre-pill--selected' : ''}`}
                  onClick={selectRandom}
                  aria-pressed={isRandomGenre}
                >
                  🎲 Random
                </button>
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
                      <button
                        className={`keyword-chip keyword-chip--random ${randomCategories.has(cat) ? 'keyword-chip--selected' : ''}`}
                        onClick={() => randomizeCategory(cat)}
                        type="button"
                        aria-pressed={randomCategories.has(cat)}
                      >
                        🎲 RANDOM
                      </button>
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
                    onClick={() => setSelectedLanguage(lang.code)}
                    aria-pressed={selectedLanguage === lang.code}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="selector__section">
              <h2 className="selector__section-title">
                What are you doing now? <span className="optional">(optional)</span>
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

            <section className="selector__section">
              <h2 className="selector__section-title">Your name?</h2>
              <input
                type="text"
                className={`feeling-input${nameError && !djName.trim() ? ' feeling-input--error' : ''}`}
                placeholder="e.g. DJ Nova"
                value={djName}
                onChange={(e) => {
                  setDjName(e.target.value.slice(0, DJ_NAME_MAX_LENGTH));
                  if (nameError) setNameError(false);
                }}
                maxLength={DJ_NAME_MAX_LENGTH}
              />
              {nameError && !djName.trim() && (
                <p className="dj-panel__name-error">Your name is required to become the DJ</p>
              )}
            </section>
          </>
        )}

        <div className="dj-panel__footer">
          <button
            className="start-button"
            onClick={handleSubmit}
            disabled={loading || (!selectedGenre && !isRandomGenre)}
          >
            Take the Stage
          </button>
          <button className="dj-panel__close" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
