import { useState, useEffect, useMemo } from 'react';
import { Genre, Keyword, Language, AdvancedOptions, Track } from '../types';

const MOOD_CATEGORY_LABELS: Record<string, string> = {
  energy: 'Energy',
  emotion: 'Emotion',
  atmosphere: 'Atmosphere',
  texture: 'Texture',
  instrument: 'Instrument',
};

const MOOD_CATEGORY_ORDER = ['energy', 'emotion', 'atmosphere', 'texture', 'instrument'];
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
const INFERENCE_STEPS_MIN = 4;
const INFERENCE_STEPS_MAX = 100;

interface GenreSelectorProps {
  onStart: (genres: string[], keywords: string[], language: string, feeling: string, djName: string, advancedOptions?: AdvancedOptions) => void;
  currentTrack: Track | null;
}

export function GenreSelector({ onStart, currentTrack }: GenreSelectorProps) {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<string>('rock');
  const [isRandomGenre, setIsRandomGenre] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [feeling, setFeeling] = useState('');
  const [djName, setDjName] = useState('');
  const [loading, setLoading] = useState(true);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [timeSignature, setTimeSignature] = useState('');
  const [inferenceSteps, setInferenceSteps] = useState(DEFAULT_INFERENCE_STEPS);
  const [ditModel, setDitModel] = useState('turbo');
  const [thinking, setThinking] = useState(true);
  const [useCotCaption, setUseCotCaption] = useState(false);
  const [useCotMetas, setUseCotMetas] = useState(false);
  const [useCotLanguage, setUseCotLanguage] = useState(false);

  useEffect(() => {
    console.log('[GenreSelector] Fetching genres, keywords, and saved options');
    Promise.all([
      fetch('/api/genres').then((r) => r.json()),
      fetch('/api/advanced-options').then((r) => r.json()),
    ])
      .then(([genreData, savedOpts]: [{ genres: Genre[]; keywords: Keyword[]; languages: Language[] }, Record<string, unknown>]) => {
        console.log('[GenreSelector] Loaded', genreData.genres.length, 'genres,', genreData.keywords.length, 'keywords,', genreData.languages.length, 'languages');
        setGenres(genreData.genres);
        setKeywords(genreData.keywords);
        setLanguages(genreData.languages);
        // Restore saved advanced options if a previous session stored them
        if (savedOpts && Object.keys(savedOpts).length > 0) {
          if (savedOpts.timeSignature !== undefined) setTimeSignature((savedOpts.timeSignature as string) ?? '');
          if (savedOpts.inferenceSteps !== undefined) setInferenceSteps(savedOpts.inferenceSteps as number);
          if (savedOpts.model !== undefined) setDitModel(savedOpts.model as string);
          if (savedOpts.thinking !== undefined) setThinking(savedOpts.thinking as boolean);
          if (savedOpts.useCotCaption !== undefined) setUseCotCaption(savedOpts.useCotCaption as boolean);
          if (savedOpts.useCotMetas !== undefined) setUseCotMetas(savedOpts.useCotMetas as boolean);
          if (savedOpts.useCotLanguage !== undefined) setUseCotLanguage(savedOpts.useCotLanguage as boolean);
          console.log('[GenreSelector] Restored saved advanced options:', savedOpts);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error('[GenreSelector] Failed to load data:', err);
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
    setIsRandomGenre(false);
    setSelectedGenre(id);
  };

  const selectRandom = () => {
    console.log('[GenreSelector] Random genre mode selected');
    setIsRandomGenre(true);
    setSelectedGenre('');
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
      thinking,
      useCotCaption,
      useCotMetas,
      useCotLanguage,
    };
    if (timeSignature) opts.timeSignature = timeSignature;
    const genreArg = isRandomGenre ? ['__random__'] : [selectedGenre];
    console.log('[GenreSelector] Starting radio with:', genreArg, keywordList, selectedLanguage, feeling, djName, opts);
    onStart(genreArg, keywordList, selectedLanguage, feeling, djName, opts);
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
                <span className="advanced-slider__label">{INFERENCE_STEPS_MIN}</span>
                <div className="advanced-slider__track-wrapper">
                  <input
                    type="range"
                    className="advanced-slider"
                    min={INFERENCE_STEPS_MIN}
                    max={INFERENCE_STEPS_MAX}
                    step={1}
                    value={inferenceSteps}
                    onChange={(e) => setInferenceSteps(Number(e.target.value))}
                  />
                  <div
                    className="advanced-slider__default-mark"
                    style={{ left: `${((DEFAULT_INFERENCE_STEPS - INFERENCE_STEPS_MIN) / (INFERENCE_STEPS_MAX - INFERENCE_STEPS_MIN)) * 100}%` }}
                    title="Default (8)"
                  />
                </div>
                <span className="advanced-slider__label">{INFERENCE_STEPS_MAX}</span>
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

            {/* ACE-Step CoT Flags */}
            <div className="advanced-options__group">
              <label className="advanced-options__label">ACE-Step CoT Flags</label>
              <div className="advanced-cot-rows">
                {([
                  { key: 'thinking',       label: 'Thinking',     value: thinking,       set: setThinking },
                  { key: 'useCotCaption',  label: 'CoT Caption',  value: useCotCaption,  set: setUseCotCaption },
                  { key: 'useCotMetas',    label: 'CoT Metas',    value: useCotMetas,    set: setUseCotMetas },
                  { key: 'useCotLanguage', label: 'CoT Language', value: useCotLanguage, set: setUseCotLanguage },
                ] as { key: string; label: string; value: boolean; set: (v: boolean) => void }[]).map(({ key, label, value, set }) => (
                  <div key={key} className="advanced-cot-row">
                    <span className="advanced-cot-row__label">{label}</span>
                    <div className="advanced-pills">
                      <button
                        className={`advanced-pill ${value ? 'advanced-pill--selected' : ''}`}
                        onClick={() => set(true)}
                      >On</button>
                      <button
                        className={`advanced-pill ${!value ? 'advanced-pill--selected' : ''}`}
                        onClick={() => set(false)}
                      >Off</button>
                    </div>
                  </div>
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
          disabled={!selectedGenre && !isRandomGenre}
        >
          {currentTrack ? 'Update Radio' : 'Start Radio'}
        </button>
      </div>
    </div>
  );
}
