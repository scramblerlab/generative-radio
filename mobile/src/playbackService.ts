// RNTP Playback Service — runs in a background thread to handle remote controls
// (lock screen, Control Center, headphone buttons, CarPlay, etc.)
import TrackPlayer, { Event } from 'react-native-track-player';

export async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteJumpForward, () =>
    TrackPlayer.getPosition().then((pos) =>
      TrackPlayer.getDuration().then((dur) =>
        TrackPlayer.seekTo(Math.min(dur, pos + 10))
      )
    )
  );
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, () =>
    TrackPlayer.getPosition().then((pos) =>
      TrackPlayer.seekTo(Math.max(0, pos - 10))
    )
  );
}
