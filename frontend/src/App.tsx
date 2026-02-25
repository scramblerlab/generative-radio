import { useState, useEffect } from 'react';
import { GenreSelector } from './components/GenreSelector';
import { RadioPlayer } from './components/RadioPlayer';
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
    setSessionInfo({ genre: genres[0] ?? '', keywords, language });
    setDjName(name);
    setView('player');
    await radio.start(genres, keywords, language, feeling, advancedOptions);
  };

  const handleStop = async () => {
    await radio.stop();
    setView('selector');
  };

  const handleBack = () => {
    radio.stop();
    setView('selector');
  };

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
            sessionInfo={sessionInfo}
            djName={djName}
            moreLikeThis={false}
            onStop={handleStop}
            onRewind={radio.rewind}
            onBack={handleBack}
            onUnblockAudio={radio.unblockAudio}
          />
        ) : (
          view === 'selector' ? (
            <GenreSelector onStart={handleStart} />
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
              viewers={radio.viewers}
              sessionInfo={sessionInfo}
              djName={djName}
              moreLikeThis={radio.moreLikeThis}
              onToggleMoreLikeThis={() => radio.setMoreLikeThis(!radio.moreLikeThis)}
              canPinSeed={!!radio.lastSeed}
              onStop={handleStop}
              onRewind={radio.rewind}
              onBack={handleBack}
              onUnblockAudio={radio.unblockAudio}
            />
          )
        )}
      </main>
    </>
  );
}
