import { useState, useEffect } from 'react';
import { GenreSelector } from './components/GenreSelector';
import { RadioPlayer } from './components/RadioPlayer';
import { DJPanel } from './components/DJPanel';
import { AuthModal } from './components/AuthModal';
import { useAuth } from './context/AuthContext';
import { useRadio } from './hooks/useRadio';
import { SessionInfo, AdvancedOptions } from '@radio/shared';
import './App.css';

type View = 'selector' | 'player';

export default function App() {
  const [view, setView] = useState<View>('player');
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const { user, isLoading: authLoading, authVersion, logout } = useAuth();
  const radio = useRadio(authVersion);

  const handleStart = async (
    genres: string[], keywords: string[], language: string,
    feeling: string, name: string, advancedOptions?: AdvancedOptions,
  ) => {
    const isRandom = genres[0] === '__random__';
    setSessionInfo({ genre: isRandom ? '' : genres[0] ?? '', keywords, language, isRandom });
    setView('player');
    if (radio.currentTrack !== null) {
      // Mid-session: keep current track playing, reschedule next track with new settings
      radio.updateSettings(genres, keywords, language, feeling, advancedOptions);
    } else {
      await radio.start(genres, keywords, language, feeling, advancedOptions, name);
    }
  };

  const handleBack = () => {
    // Do NOT stop — audio keeps playing while controller browses genres
    setView('selector');
  };

  // A DJ claim refused for an auth reason means the remedy is signing in, so
  // open that modal rather than leaving the button looking broken.
  useEffect(() => {
    if (radio.djClaimRefusal) setAuthModalOpen(true);
  }, [radio.djClaimRefusal]);

  // Keep sessionInfo.genre in sync with the actual genre used for each track.
  // This is essential in Random mode where the genre changes per-track.
  useEffect(() => {
    if (radio.currentTrack?.genre) {
      setSessionInfo(prev => prev ? { ...prev, genre: radio.currentTrack!.genre } : prev);
    }
  }, [radio.currentTrack?.id]);

  // When a viewer is promoted to controller while a session is active, automatically
  // show the player view so they see the current track with full controls.
  useEffect(() => {
    if (
      radio.role === 'controller' &&
      (radio.status === 'playing' || radio.status === 'generating' || radio.status === 'buffering')
    ) {
      setView('player');
    }
  }, [radio.role, radio.status]);

  return (
    <>
      {/* Audio element — always in DOM so audioRef is always valid */}
      <audio ref={radio.audioRef} preload="auto" />

      {/* DJ panel modal — rendered above everything, visible to whichever client claimed the slot */}
      {radio.djPanelOpen && (
        <DJPanel nickname={radio.djNickname} onSubmit={radio.submitDj} onClose={radio.closeDjPanel} />
      )}

      {authModalOpen && <AuthModal onClose={() => setAuthModalOpen(false)} />}

      {/* Hidden until the session-restore call resolves, so a signed-in user
          never sees a "Sign in" button flash on load. */}
      {!authLoading && (
        <div className="auth-bar">
          {user ? (
            <>
              <span className="auth-bar__nickname">{user.nickname}</span>
              <button className="auth-bar__btn" onClick={logout}>Sign out</button>
            </>
          ) : (
            <button className="auth-bar__btn" onClick={() => setAuthModalOpen(true)}>Sign in</button>
          )}
        </div>
      )}

      <main className="app">
        {radio.role === null ? (
          <div className="selector-loading">
            <div className="spinner" />
            <p>Connecting...</p>
          </div>
        ) : radio.role === 'viewer' ? (
          <RadioPlayer
            readonly
            track={radio.currentTrack}
            status={radio.status}
            nextReady={radio.nextReady}
            statusMessage={radio.statusMessage}
            errorMessage={radio.errorMessage}
            activityLog={radio.activityLog}
            progress={radio.progress}
            listenerCount={radio.listenerCount}
            audioDuration={radio.audioDuration}
            sessionInfo={sessionInfo}
            localPaused={radio.localPaused}
            onTogglePlayPause={radio.togglePlayPause}
            onSeekBackward={radio.seekBackward}
            onSeekForward={radio.seekForward}
            onBack={handleBack}
            djAvailable={radio.djAvailable}
            djUnlockAt={radio.djUnlockAt}
            onClaimDj={radio.claimDj}
            reactionState={radio.reactionState}
            onReact={radio.currentTrack ? (action) => radio.react(radio.currentTrack!.id, action) : undefined}
          />
        ) : (
          view === 'selector' ? (
            <GenreSelector onStart={handleStart} onBackToPlayer={() => setView('player')} currentTrack={radio.currentTrack} />
          ) : (
            <RadioPlayer
              readonly={false}
              track={radio.currentTrack}
              status={radio.status}
              nextReady={radio.nextReady}
              statusMessage={radio.statusMessage}
              errorMessage={radio.errorMessage}
              activityLog={radio.activityLog}
              progress={radio.progress}
              listenerCount={radio.listenerCount}
              audioDuration={radio.audioDuration}
              viewers={radio.viewers}
              sessionInfo={sessionInfo}
              localPaused={radio.localPaused}
              onTogglePlayPause={radio.togglePlayPause}
              onSeekBackward={radio.seekBackward}
              onSeekForward={radio.seekForward}
onBack={handleBack}
              djAvailable={radio.djAvailable}
              djUnlockAt={radio.djUnlockAt}
                onClaimDj={radio.claimDj}
              reactionState={radio.reactionState}
              onReact={radio.currentTrack ? (action) => radio.react(radio.currentTrack!.id, action) : undefined}
            />
          )
        )}
      </main>
    </>
  );
}
