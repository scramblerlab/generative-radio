import { useState } from 'react';
import { GenreSelector } from './components/GenreSelector';
import { RadioPlayer } from './components/RadioPlayer';
import { useRadio } from './hooks/useRadio';
import './App.css';

type View = 'selector' | 'player';

export default function App() {
  const [view, setView] = useState<View>('selector');
  const radio = useRadio();

  const handleStart = async (genres: string[], keywords: string[]) => {
    setView('player');
    await radio.start(genres, keywords);
  };

  const handleStop = async () => {
    await radio.stop();
    setView('selector');
  };

  const handleBack = () => {
    radio.stop();
    setView('selector');
  };

  return (
    <>
      {/* Audio element — always in DOM so audioRef is always valid */}
      <audio ref={radio.audioRef} preload="auto" />

      <main className="app">
        {view === 'selector' ? (
          <GenreSelector onStart={handleStart} />
        ) : (
          <RadioPlayer
            track={radio.currentTrack}
            status={radio.status}
            nextReady={radio.nextReady}
            statusMessage={radio.statusMessage}
            errorMessage={radio.errorMessage}
            activityLog={radio.activityLog}
            progress={radio.progress}
            onStop={handleStop}
            onRewind={radio.rewind}
            onBack={handleBack}
          />
        )}
      </main>
    </>
  );
}
