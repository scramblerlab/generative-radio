import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { UseRadioReturn } from '../hooks/useRadio';
import { GenreSelector } from '../components/GenreSelector';
import { RadioPlayer } from '../components/RadioPlayer';
import { DJPanel } from '../components/DJPanel';
import { AdvancedOptions } from '@radio/shared';
import { colors } from '../components/theme';

const Stack = createStackNavigator();

interface Props {
  radio: UseRadioReturn;
}

export function AppNavigator({ radio }: Props) {
  const {
    role, status, currentTrack, nextReady, statusMessage, errorMessage,
    activityLog, progress, audioDuration, listenerCount, localPaused,
    djLocked, djUnlockAt, activeDjName, djPanelOpen, reactionState,
    start, stop, updateSettings, saveTrack,
    togglePlayPause, seekBackward, seekForward,
    claimDj, submitDj, closeDjPanel, react,
  } = radio;

  // Connecting spinner while WS handshake is in progress
  if (role === null) {
    return (
      <View style={styles.connecting}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.connectingText}>Connecting…</Text>
      </View>
    );
  }

  const isController = role === 'controller';

  const handleStart = (
    genres: string[], keywords: string[], language: string,
    feeling: string, _djName: string, advancedOptions?: AdvancedOptions
  ) => {
    start(genres, keywords, language, feeling, advancedOptions);
  };

  const handleUpdate = (
    genres: string[], keywords: string[], language: string,
    feeling: string, _djName: string, advancedOptions?: AdvancedOptions
  ) => {
    updateSettings(genres, keywords, language, feeling, advancedOptions);
  };

  // Viewer: always show player (read-only except DJ — everyone can be DJ)
  if (!isController) {
    return (
      <NavigationContainer>
        <>
          <RadioPlayer
            readonly
            track={currentTrack}
            status={status}
            nextReady={nextReady}
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
          <DJPanel
            visible={djPanelOpen}
            onSubmit={submitDj}
            onClose={closeDjPanel}
          />
        </>
      </NavigationContainer>
    );
  }

  // Controller: stack navigation between Selector and Player
  const isSessionActive = status !== 'idle' && status !== 'stopped';

  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName={isSessionActive ? 'Player' : 'Selector'}
        screenOptions={{ headerShown: false, cardStyle: { backgroundColor: colors.bg } }}
      >
        <Stack.Screen name="Selector">
          {({ navigation }) => (
            <GenreSelector
              onStart={(genres, keywords, language, feeling, djName, adv) => {
                handleStart(genres, keywords, language, feeling, djName, adv);
                navigation.navigate('Player');
              }}
              onBackToPlayer={isSessionActive ? () => navigation.navigate('Player') : undefined}
              isStarted={isSessionActive}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Player">
          {({ navigation }) => (
            <>
              <RadioPlayer
                readonly={false}
                track={currentTrack}
                status={status}
                nextReady={nextReady}
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
                onChangeGenre={() => navigation.navigate('Selector')}
                onClaimDj={claimDj}
                onReact={react}
              />
              <DJPanel
                visible={djPanelOpen}
                onSubmit={submitDj}
                onClose={closeDjPanel}
              />
            </>
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  connecting: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' },
  connectingText: { color: colors.textMuted, marginTop: 16, fontSize: 16 },
});
