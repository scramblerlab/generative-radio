import { useState, useEffect, useMemo } from 'react';
import { Genre, Keyword, Language, AdvancedOptions, Track } from '../types';

const MOOD_CATEGORY_LABELS: Record<string, string> = {
  energy: 'Energy',
  emotion: 'Emotion',
  atmosphere: 'Atmosphere',
  texture: 'Texture',
};

const MOOD_CATEGORY_ORDER = ['energy', 'emotion', 'atmosphere', 'texture'];
const FEELING_MAX_LENGTH = 200;

const TIME_SIGNATURES = [
  { value: '', label: 'None' },
  { value: '2', label: '2/4' },
  { value: '3', label: '3/4' },
  { value: '4', label: '4/4' },
  { value: '6', label: '6/8' },
];

const DIT_MODELS = [
  { value: 'turbo', label: 'turbo' },
  { value: 'turbo-shift1', label: 'turbo-shift1' },
  { value: 'turbo-shift3', label: 'turbo-shift3' },
  { value: 'turbo-continuous', label: 'turbo-continuous' },
];

const DEFAULT_INFERENCE_STEPS = 8;

interface GenreSelectorProps {
  onStart: (genres: string[], keywords: string[], language: string, feeling: string, djName: string, advancedOptions?: AdvancedOptions) => void;
  currentTrack: Track | null;
}

export function GenreSelector({ onStart, currentTrack }: GenreSelectorProps) {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<string>('rock');
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [feeling, setFeeling] = useState('');
  const [djName, setDjName] = useState('');
  const [loading, setLoading] = useState(true);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [timeSignature, setTimeSignature] = useState('');
  const [inferenceSteps, setInferenceSteps] = useState(DEFAULT_INFERENCE_STEPS);
  const [ditModel, setDitModel] = useState('turbo');

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
    const opts: AdvancedOptions = {
      inferenceSteps,
      model: ditModel,
    };
    if (timeSignature) opts.timeSignature = timeSignature;
    console.log('[GenreSelector] Starting radio with:', selectedGenre, keywordList, selectedLanguage, feeling, djName, opts);
    onStart([selectedGenre], keywordList, selectedLanguage, feeling, djName, opts);
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

      {currentTrack && (
        <div className="now-playing-banner">
          <span className="now-playing-banner__label">♪ Now Playing</span>
          <span className="now-playing-banner__title">{currentTrack.songTitle}</span>
          <span className="now-playing-banner__hint">Pick new settings — "Update Radio" applies them on the next track</span>
        </div>
      )}

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

      <section className="selector__section">
        <h2 className="selector__section-title">
          Your name? <span className="optional">(optional)</span>
        </h2>
        <input
          type="text"
          className="feeling-input"
          placeholder="e.g. DJ Nova"
          value={djName}
          onChange={(e) => setDjName(e.target.value.slice(0, 50))}
          maxLength={50}
        />
      </section>

      {/* Advanced Options */}
      <section className="selector__section">
        <button
          className="advanced-toggle"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <span className={`advanced-toggle__arrow ${advancedOpen ? 'advanced-toggle__arrow--open' : ''}`}>
            &#9654;
          </span>
          Advanced Options
        </button>
        {advancedOpen && (
          <div className="advanced-options">
            <p className="advanced-options__help">
              <a
                href="https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/Tutorial.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                Learn more about these parameters
              </a>
            </p>

            {/* Time Signature */}
            <div className="advanced-options__group">
              <label className="advanced-options__label">Time Signature</label>
              <div className="advanced-pills">
                {TIME_SIGNATURES.map((ts) => (
                  <button
                    key={ts.value}
                    className={`advanced-pill ${timeSignature === ts.value ? 'advanced-pill--selected' : ''}`}
                    onClick={() => setTimeSignature(ts.value)}
                  >
                    {ts.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Inference Steps */}
            <div className="advanced-options__group">
              <label className="advanced-options__label">
                Inference Steps
                <span className={`advanced-options__value ${inferenceSteps === DEFAULT_INFERENCE_STEPS ? 'advanced-options__value--default' : ''}`}>
                  {inferenceSteps}
                  {inferenceSteps === DEFAULT_INFERENCE_STEPS && ' (default)'}
                </span>
              </label>
              <div className="advanced-slider-wrapper">
                <span className="advanced-slider__label">4</span>
                <div className="advanced-slider__track-wrapper">
                  <input
                    type="range"
                    className="advanced-slider"
                    min={4}
                    max={16}
                    step={1}
                    value={inferenceSteps}
                    onChange={(e) => setInferenceSteps(Number(e.target.value))}
                  />
                  <div
                    className="advanced-slider__default-mark"
                    style={{ left: `${((DEFAULT_INFERENCE_STEPS - 4) / 12) * 100}%` }}
                    title="Default (8)"
                  />
                </div>
                <span className="advanced-slider__label">16</span>
              </div>
            </div>

            {/* DiT Model Variant */}
            <div className="advanced-options__group">
              <label className="advanced-options__label">DiT Model Variant</label>
              <div className="advanced-pills">
                {DIT_MODELS.map((m) => (
                  <button
                    key={m.value}
                    className={`advanced-pill ${ditModel === m.value ? 'advanced-pill--selected' : ''}`}
                    onClick={() => setDitModel(m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
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
          {currentTrack ? 'Update Radio' : 'Start Radio'}
        </button>
      </div>
    </div>
  );
}
