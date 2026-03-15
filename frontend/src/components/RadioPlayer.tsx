import { useEffect, useRef, useState } from 'react';
import { Track, RadioStatus, ActivityEntry, ProgressStage, ViewerInfo, SessionInfo } from '../types';
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

/** Abbreviate a full IPv6 address to `first::last` for compact display.
 *  Plain IPv4 addresses are returned unchanged. */
function formatIp(ip: string): string {
  if (!ip.includes(':')) return ip; // IPv4 — already readable
  const groups = ip.split(':');
  return `${groups[0]}::${groups[groups.length - 1]}`;
}

function formatListeningSince(connectedAt: number): string {
  const diffSec = Math.floor(Date.now() / 1000 - connectedAt);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ${diffMin % 60}m ago`;
}

interface RadioPlayerProps {
  readonly: boolean;
  track: Track | null;
  status: RadioStatus;
  nextReady: boolean;
  statusMessage: string;
  errorMessage: string | null;
  activityLog: ActivityEntry[];
  progress: number; // 0–1
  listenerCount: number;
  audioBlocked: boolean;
  audioDuration?: number | null;
  viewers?: ViewerInfo[];
  sessionInfo?: SessionInfo | null;
  djName?: string;
  localPaused?: boolean;
  onTogglePlayPause?: () => void;
  onSeekBackward?: () => void;
  onSeekForward?: () => void;
  onSaveTrack?: () => Promise<void>;
  onBack: () => void;
  onUnblockAudio: () => void;
  // DJ mode
  djUnlockAt: number;
  activeDjName?: string;
  onClaimDj: () => void;
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
  readonly,
  track,
  status,
  nextReady,
  statusMessage,
  errorMessage,
  activityLog,
  progress,
  listenerCount,
  audioBlocked,
  audioDuration,
  viewers = [],
  sessionInfo,
  djName = '',
  localPaused = false,
  onTogglePlayPause,
  onSeekBackward,
  onSeekForward,
  onSaveTrack,
  onBack,
  onUnblockAudio,
  djUnlockAt,
  activeDjName,
  onClaimDj,
}: RadioPlayerProps) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [showToast, setShowToast] = useState(false);
  // Tick every second so we can recompute the countdown and locked state locally.
  // The server only sends dj_state on discrete events (connect, claim, submit) — it
  // does NOT push an explicit event when the timer expires. So we derive the locked
  // state from `djUnlockAt` (the Unix timestamp) rather than trusting `djLocked`.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const nowSec = Date.now() / 1000;
  // remainingSec = Infinity when unlockAt is unknown (initial 0); otherwise clamped to ≥0
  const remainingSec = djUnlockAt > 0 ? Math.max(0, Math.ceil(djUnlockAt - nowSec)) : Infinity;
  const effectiveDjLocked = remainingSec > 0;
  const djCountdown =
    effectiveDjLocked && remainingSec !== Infinity
      ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, '0')}`
      : '';

  // Reset save state when the track changes
  useEffect(() => {
    setSaveState('idle');
  }, [track?.id]);
  const isPlaying = status === 'playing';
  const isLoading = status === 'generating' || status === 'buffering' || status === 'connecting';

  return (
    <div className="player">
      {readonly ? (
        <div className="player__viewer-badge">Now Listening</div>
      ) : (
        <div className="player__top-bar">
          <button className="player__back" onClick={onBack} title="Change genres">
            ← Change Genres
          </button>
          {onSaveTrack && track && (
            <button
              className={`player__save-track`}
              disabled={saveState === 'saving'}
              title="Save this track's MP3 and metadata to saved_tracks/"
              onClick={async () => {
                setSaveState('saving');
                try {
                  await onSaveTrack();
                  setSaveState('idle');
                  setShowToast(true);
                  setTimeout(() => setShowToast(false), 3000);
                } catch {
                  setSaveState('error');
                  setTimeout(() => setSaveState('idle'), 2000);
                }
              }}
            >
              Save Track
            </button>
          )}
        </div>
      )}

      {/* Save toast */}
      {showToast && (
        <div className="player__save-toast">✓ Track saved</div>
      )}

      <div className="player__card">
        {/* Single badge: shows controller prefix for host, genre info for all */}
        {track?.genre && (
          <div className="player__controller-badge">
            {!readonly && `CONTROLLER :: `}
            {track.isRandom
              ? `RANDOM · ${track.genre.toUpperCase()}`
              : track.genre.toUpperCase()}
          </div>
        )}

        {/* Now Playing */}
        <div className="player__now-playing">
          <Equalizer active={isPlaying && !audioBlocked} />

          {/* Viewer tap-to-listen gate — shown when browser blocked autoplay */}
          {readonly && audioBlocked && track ? (
            <button className="player__unblock-btn" onClick={onUnblockAudio}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              Tap to Listen
            </button>
          ) : track ? (
            <div className="player__track-info">
              <h2 className="player__song-title">{track.songTitle}</h2>
              {sessionInfo && (sessionInfo.keywords.length > 0 || sessionInfo.language) && (
                <p className="player__session-info">
                  {sessionInfo.keywords.length > 0 && sessionInfo.keywords.join(', ')}
                  {sessionInfo.language && ` · ${sessionInfo.language === 'instrumental' ? 'Instrumental' : sessionInfo.language.toUpperCase()}`}
                </p>
              )}
              <p className="player__tags">{track.tags}</p>
              <p className="player__meta">
                {track.bpm} BPM · {track.keyScale} · {audioDuration ?? track.duration}s
              </p>
              {track.lyrics && (
                <div className="player__lyrics">
                  <div className="player__lyrics-scroll">
                    <p className="player__lyrics-text">{track.lyrics}</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="player__track-info player__track-info--empty">
              <h2 className="player__song-title">
                {isLoading ? 'Generating...' : readonly ? 'Waiting for host...' : 'Ready'}
              </h2>
              <p className="player__tags">
                {status === 'generating'
                  ? 'Your first track is on its way'
                  : status === 'buffering'
                    ? 'Loading next track...'
                    : readonly
                      ? 'The host will start the radio soon'
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

        {/* Transport controls: rewind 10s / play-pause / forward 10s */}
        {track && (onTogglePlayPause || onSeekBackward || onSeekForward) && (
          <div className="player__controls">
            <button
              className="player__icon-btn"
              onClick={onSeekBackward}
              disabled={!onSeekBackward}
              aria-label="Rewind 10 seconds"
              title="Rewind 10s"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                <text x="12" y="15.5" textAnchor="middle" fontSize="6" fontFamily="sans-serif" fontWeight="bold" fill="currentColor">10</text>
              </svg>
            </button>

            <button
              className="player__play-btn"
              onClick={onTogglePlayPause}
              disabled={!onTogglePlayPause || (!isPlaying && !localPaused)}
              aria-label={localPaused ? 'Play' : 'Pause'}
              title={localPaused ? 'Play' : 'Pause'}
            >
              {localPaused ? (
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
              )}
            </button>

            <button
              className="player__icon-btn"
              onClick={onSeekForward}
              disabled={!onSeekForward}
              aria-label="Forward 10 seconds"
              title="Forward 10s"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18 13c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6v4l5-5-5-5v4c-4.42 0-8 3.58-8 8s3.58 8 8 8 8-3.58 8-8h-2z"/>
                <text x="12" y="15.5" textAnchor="middle" fontSize="6" fontFamily="sans-serif" fontWeight="bold" fill="currentColor">10</text>
              </svg>
            </button>
          </div>
        )}

        {/* Activity log — shown while generating or buffering */}
        {(status === 'generating' || status === 'buffering') && (
          <ActivityLog entries={activityLog} />
        )}

        {/* Error */}
        {errorMessage && (
          <div className="player__error">
            ⚠ {errorMessage}
          </div>
        )}

        {/* Controller-only: invite description + viewer list */}
        {!readonly && (
          <>
            <p className="player__invite-text">
              Others can join as listeners by opening this page's URL — they'll hear the stream in read-only mode.
            </p>

            <div className="player__viewer-list">
              <h3 className="player__viewer-list-heading">
                Listeners ({viewers.length})
              </h3>
              {viewers.length === 0 ? (
                <p className="player__viewer-empty">No listeners connected</p>
              ) : (
                viewers.map((v, i) => (
                  <div key={i} className="player__viewer-item">
                    <span className="player__viewer-ip">{formatIp(v.ip)}</span>
                    <span className="player__viewer-since">
                      {formatListeningSince(v.connectedAt)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* DJ mode — visible to all users */}
        <div className="player__dj-section">
          <button
            className={`player__dj-btn${effectiveDjLocked ? ' player__dj-btn--locked' : ''}`}
            onClick={onClaimDj}
            disabled={effectiveDjLocked}
          >
            Generate Your Tracks
          </button>
          {effectiveDjLocked && djCountdown && (
            <p className="player__dj-unlock-timer">Unlocks in {djCountdown}</p>
          )}
          {activeDjName && (
            <p className="player__dj-active">Now curated by {activeDjName}</p>
          )}
        </div>
      </div>

      <StatusBar status={status} message={statusMessage} nextReady={nextReady} listenerCount={listenerCount} />

      <p className="player__presented-by">
        {djName.trim()
          ? `PRESENTED BY ${djName.trim().toUpperCase()} AND GENERATIVE RADIO`
          : 'PRESENTED BY GENERATIVE RADIO'}
      </p>
    </div>
  );
}
