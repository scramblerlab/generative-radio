import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { UseRadioReturn } from '../hooks/useRadio';
import { RadioPlayer } from '../components/RadioPlayer';
import { DJPanel } from '../components/DJPanel';
import { IPadLayout } from '../components/iPadLayout';

interface Props {
  radio: UseRadioReturn;
}

/**
 * Always-viewer: one screen, connects immediately without waiting for WS role.
 * WS connects in the background; backend auto-starts a RANDOM session on first connection.
 */
export function AppNavigator({ radio }: Props) {
  const {
    status, currentTrack, statusMessage, errorMessage,
    activityLog, progress, audioDuration, listenerCount, viewers, localPaused,
    djLocked, djUnlockAt, activeDjName, djPanelOpen, reactionState,
    togglePlayPause, seekBackward, seekForward,
    claimDj, submitDj, closeDjPanel, react,
  } = radio;

  return (
    <NavigationContainer>
      <>
        <IPadLayout
          track={currentTrack}
          activityLog={activityLog}
          listenerCount={listenerCount}
          viewers={viewers}
          audioDuration={audioDuration}
        >
          <RadioPlayer
            readonly
            track={currentTrack}
            status={status}
            statusMessage={statusMessage}
            errorMessage={errorMessage}
            activityLog={activityLog}
            progress={progress}
            audioDuration={audioDuration}
            listenerCount={listenerCount}
            localPaused={localPaused}
            djLocked={djLocked}
            djUnlockAt={djUnlockAt}
            activeDjName={activeDjName}
            reactionState={reactionState}
            onTogglePlayPause={togglePlayPause}
            onSeekBackward={seekBackward}
            onSeekForward={seekForward}
            onClaimDj={claimDj}
            onReact={react}
          />
        </IPadLayout>
        <DJPanel
          visible={djPanelOpen}
          onSubmit={submitDj}
          onClose={closeDjPanel}
        />
      </>
    </NavigationContainer>
  );
}
