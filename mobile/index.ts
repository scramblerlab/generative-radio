import { registerRootComponent } from 'expo';
import TrackPlayer from 'react-native-track-player';
import App from './src/App';
import { PlaybackService } from './src/playbackService';

// Register the RNTP background playback service
TrackPlayer.registerPlaybackService(() => PlaybackService);

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
registerRootComponent(App);
