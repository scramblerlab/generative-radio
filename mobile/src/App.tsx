import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRadio } from './hooks/useRadio';
import { AppNavigator } from './navigation/AppNavigator';

export default function App() {
  const radio = useRadio();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <AppNavigator radio={radio} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
