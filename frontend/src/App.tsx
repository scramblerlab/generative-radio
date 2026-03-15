import { useState, useEffect } from 'react';
import { GenreSelector } from './components/GenreSelector';
import { RadioPlayer } from './components/RadioPlayer';
import { DJPanel } from './components/DJPanel';
import { useRadio } from './hooks/useRadio';
import { SessionInfo, AdvancedOptions } from './types';
import './App.css';

type View = 'selector' | 'player';

export default function App() {
  const [view, setView] = useState<View>('selector');
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [djName, setDjName] = useState('');
  const radio = useRadio();

  const handleStart = async (
    genres: string[], keywords: string[], language: string,
    feeling: string, name: string, advancedOptions?: AdvancedOptions,
  ) => {
    const isRandom = genres[0] === '__random__';
    setSessionInfo({ genre: isRandom ? '' : genres[0] ?? '', keywords, language, isRandom });
    setDjName(name);
    setView('player');
    if (radio.currentTrack !== null) {
      // Mid-session: keep current track playing, reschedule next track with new settings
      radio.updateSettings(genres, keywords, language, feeling, advancedOptions);
    } else {
      await radio.start(genres, keywords, language, feeling, advancedOptions);
    }
  };

  const handleBack = () => {
    // Do NOT stop — audio keeps playing while controller browses genres
    setView('selector');
  };

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
        <DJPanel onSubmit={radio.submitDj} onClose={radio.closeDjPanel} />
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
            audioBlocked={radio.audioBlocked}
            audioDuration={radio.audioDuration}
            sessionInfo={sessionInfo}
            djName={djName}
            localPaused={radio.localPaused}
            onTogglePlayPause={radio.togglePlayPause}
            onSeekBackward={radio.seekBackward}
            onSeekForward={radio.seekForward}
            onBack={handleBack}
            onUnblockAudio={radio.unblockAudio}
            djUnlockAt={radio.djUnlockAt}
            activeDjName={radio.activeDjName}
            onClaimDj={radio.claimDj}
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
              audioBlocked={radio.audioBlocked}
              audioDuration={radio.audioDuration}
              viewers={radio.viewers}
              sessionInfo={sessionInfo}
              djName={djName}
              localPaused={radio.localPaused}
              onTogglePlayPause={radio.togglePlayPause}
              onSeekBackward={radio.seekBackward}
              onSeekForward={radio.seekForward}
              onSaveTrack={radio.currentTrack ? () => radio.saveTrack(radio.currentTrack!.id) : undefined}
              onBack={handleBack}
              onUnblockAudio={radio.unblockAudio}
              djUnlockAt={radio.djUnlockAt}
              activeDjName={radio.activeDjName}
              onClaimDj={radio.claimDj}
            />
          )
        )}
      </main>
    </>
  );
}
