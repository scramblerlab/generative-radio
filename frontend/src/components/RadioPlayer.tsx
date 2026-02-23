import { useEffect, useRef } from 'react';
import { Track, RadioStatus, ActivityEntry, ProgressStage } from '../types';
import { StatusBar } from './StatusBar';

const STAGE_ICON: Record<ProgressStage, string> = {
  llm_thinking:    '🎙',
  llm_done:        '🎵',
  acestep_start:   '🎹',
  acestep_progress:'⏳',
  acestep_done:    '✓',
};

function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  if (entries.length === 0) return null;

  const visible = entries.slice(-8);
  return (
    <div className="activity-log">
      {visible.map((e) => (
        <div
          key={e.id}
          className={`activity-log__entry activity-log__entry--${e.stage}`}
        >
          <span className="activity-log__icon">{STAGE_ICON[e.stage] ?? '·'}</span>
          <span className="activity-log__msg">{e.message}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

interface RadioPlayerProps {
  track: Track | null;
  status: RadioStatus;
  nextReady: boolean;
  statusMessage: string;
  errorMessage: string | null;
  activityLog: ActivityEntry[];
  progress: number; // 0–1
  listenerCount: number;
  onStop: () => void;
  onRewind: () => void;
  onBack: () => void;
}

function Equalizer({ active }: { active: boolean }) {
  return (
    <div className={`equalizer ${active ? 'equalizer--active' : ''}`} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="equalizer__bar" />
      ))}
    </div>
  );
}

export function RadioPlayer({
  track,
  status,
  nextReady,
  statusMessage,
  errorMessage,
  activityLog,
  progress,
  listenerCount,
  onStop,
  onRewind,
  onBack,
}: RadioPlayerProps) {
  const isPlaying = status === 'playing';
  const isLoading = status === 'generating' || status === 'buffering' || status === 'connecting';

  return (
    <div className="player">
      <button className="player__back" onClick={onBack} title="Change genres">
        ← Change genres
      </button>

      <div className="player__card">
        {/* Now Playing */}
        <div className="player__now-playing">
          <Equalizer active={isPlaying} />

          {track ? (
            <div className="player__track-info">
              <h2 className="player__song-title">{track.songTitle}</h2>
              <p className="player__tags">{track.tags}</p>
              <p className="player__meta">
                {track.bpm} BPM · {track.keyScale} · {track.duration}s
              </p>
            </div>
          ) : (
            <div className="player__track-info player__track-info--empty">
              <h2 className="player__song-title">
                {isLoading ? 'Generating...' : 'Ready'}
              </h2>
              <p className="player__tags">
                {status === 'generating'
                  ? 'Your first track is on its way'
                  : status === 'buffering'
                    ? 'Loading next track...'
                    : 'Select genres to begin'}
              </p>
            </div>
          )}
        </div>

        {/* Progress bar */}
        <div className="player__progress">
          <div
            className="player__progress-fill"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>

        {/* Activity log — shown while generating or buffering */}
        {(status === 'generating' || status === 'buffering') && (
          <ActivityLog entries={activityLog} />
        )}

        {/* Controls */}
        <div className="player__controls">
          {/* Rewind */}
          <button
            className="player__icon-btn"
            onClick={onRewind}
            aria-label="Rewind to beginning"
            disabled={!track}
            title="Restart from beginning"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zM17.5 12 9 6v12l8.5-6z" />
            </svg>
          </button>

          {/* Play / Stop */}
          <button
            className={`player__play-btn ${isPlaying ? 'player__play-btn--active' : ''}`}
            onClick={onStop}
            aria-label={isPlaying ? 'Stop radio' : isLoading ? 'Loading...' : 'Start radio'}
            disabled={isLoading && !track}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="4" height="12" rx="1" />
                <rect x="14" y="6" width="4" height="12" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="8" opacity="0.3" />
                <path d="M12 4a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
                </path>
              </svg>
            )}
          </button>

          {/* Rewind mirror — keeps the play button visually centred */}
          <div className="player__icon-btn player__icon-btn--spacer" aria-hidden="true" />
        </div>

        {/* Error */}
        {errorMessage && (
          <div className="player__error">
            ⚠ {errorMessage}
          </div>
        )}
      </div>

      <StatusBar status={status} message={statusMessage} nextReady={nextReady} listenerCount={listenerCount} />
    </div>
  );
}
