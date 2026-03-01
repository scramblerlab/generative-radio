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
  onSaveTrack?: () => Promise<void>;
  onStop: () => void;
  onRewind: () => void;
  onBack: () => void;
  onUnblockAudio: () => void;
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
  onSaveTrack,
  onStop,
  onRewind,
  onBack,
  onUnblockAudio,
}: RadioPlayerProps) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [showToast, setShowToast] = useState(false);

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
            ← Change genres
          </button>
          {onSaveTrack && track && (
            <button
              className={`player__save-track player__save-track--${saveState}`}
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
              {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? '⚠ Error' : 'Save Track'}
            </button>
          )}
        </div>
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
      </div>

      {/* Save toast */}
      {showToast && (
        <div className="save-toast">✓ Track saved</div>
      )}

      <StatusBar status={status} message={statusMessage} nextReady={nextReady} listenerCount={listenerCount} />

      <p className="player__presented-by">
        {djName.trim()
          ? `PRESENTED BY ${djName.trim().toUpperCase()} AND GENERATIVE RADIO`
          : 'PRESENTED BY GENERATIVE RADIO'}
      </p>
    </div>
  );
}
