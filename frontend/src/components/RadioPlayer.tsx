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
  muted?: boolean;
  onToggleMute?: () => void;
  onSaveTrack?: () => Promise<void>;
  onStop: () => void;
  onRewind: () => void;
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
  muted = false,
  onToggleMute,
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

        {/* Mute button — per-client, no WS event sent */}
        {track && onToggleMute && (
          <div className="player__mute-row">
            <button
              className="player__mute-btn"
              onClick={onToggleMute}
              title={muted ? 'Unmute' : 'Mute'}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? (
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                  <path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                </svg>
              )}
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
