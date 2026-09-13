import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { UseRadioReturn } from '../hooks/useRadio';
import { UseAuthReturn } from '../hooks/useAuth';
import { RadioPlayer } from '../components/RadioPlayer';
import { DJPanel } from '../components/DJPanel';
import { OfflinePanel } from '../components/OfflinePanel';
import { AuthModal } from '../components/AuthModal';
import { IPadLayout } from '../components/iPadLayout';

interface Props {
  radio: UseRadioReturn;
  auth: UseAuthReturn;
}

/**
 * Always-viewer: one screen, connects immediately without waiting for WS role.
 * WS connects in the background; backend auto-starts a RANDOM session on first connection.
 */
export function AppNavigator({ radio, auth }: Props) {
  const {
    status, currentTrack, statusMessage, errorMessage,
    activityLog, progress, audioDuration, listenerCount, viewers, localPaused,
    djLocked, djUnlockAt, activeDjName, djPanelOpen, reactionState,
    djAvailable, djNickname, djClaimRefusal, clearDjClaimRefusal,
    togglePlayPause, seekBackward, seekForward,
    claimDj, submitDj, closeDjPanel, react,
    offlineMode, offlineTrackCount, enterOfflineMode, exitOfflineMode,
  } = radio;

  const { user, token, isAuthenticated, isLoading, signup, login, logout } = auth;

  const [offlinePanelOpen, setOfflinePanelOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // A claim the server refused for an auth reason opens the modal itself: the
  // button is hidden while signed out, so this is the expired-session path.
  useEffect(() => {
    if (djClaimRefusal) setAuthModalOpen(true);
  }, [djClaimRefusal]);

  const closeAuthModal = () => {
    setAuthModalOpen(false);
    clearDjClaimRefusal();
  };

  // DJ mode and offline downloads are members-only. Gate on the server's
  // verdict (djAvailable, from role_assigned) rather than on holding a token,
  // so an expired session hides the button instead of failing on tap. Offline
  // mode only needs a valid token for the library endpoints, so it goes by the
  // local session — and while it is still loading, neither is offered.
  const showDj      = !isLoading && isAuthenticated && djAvailable;
  const showOffline = !isLoading && isAuthenticated;

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
            onClaimDj={offlineMode || !showDj ? undefined : claimDj}
            onReact={offlineMode ? undefined : react}
            offlineMode={offlineMode}
            offlineTrackCount={offlineTrackCount}
            onOpenOfflinePanel={showOffline ? () => setOfflinePanelOpen(true) : undefined}
            onExitOffline={exitOfflineMode}
            onSignIn={isLoading || isAuthenticated ? undefined : () => setAuthModalOpen(true)}
            onSignOut={isAuthenticated ? logout : undefined}
            nickname={user?.nickname}
          />
        </IPadLayout>
        <DJPanel
          visible={djPanelOpen}
          onSubmit={submitDj}
          onClose={closeDjPanel}
          nickname={djNickname || user?.nickname || ''}
        />
        <OfflinePanel
          visible={offlinePanelOpen}
          onClose={() => setOfflinePanelOpen(false)}
          onStartOffline={enterOfflineMode}
          token={token}
        />
        <AuthModal
          visible={authModalOpen}
          onClose={closeAuthModal}
          signup={signup}
          login={login}
          notice={djClaimRefusal === 'session_expired'
            ? 'Your session expired — sign in again to be the DJ.'
            : djClaimRefusal === 'auth_required'
              ? 'DJ mode is for members. Sign in to continue.'
              : null}
        />
      </>
    </NavigationContainer>
  );
}
