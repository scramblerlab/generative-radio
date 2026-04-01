import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, InterruptionMode } from 'expo-audio';
import {
  Track,
  RadioStatus,
  WSMessage,
  StatusData,
  ErrorData,
  ActivityEntry,
  ProgressData,
  ListenerCountData,
  ViewerInfo,
  ViewerListData,
  DjStateData,
  DjClaimAckData,
  ReactionState,
  ReactionUpdateData,
} from '@radio/shared';
import { BACKEND_URL, WS_URL } from '../config';
import { downloadAudio } from '../utils/downloadAudio';
import { fetchStatusNative, sendTrackEndedNative } from '../modules/backgroundHttp';
import type { StatusResult } from '../modules/backgroundHttp';

// ------------------------------------------------------------------ //
// Types
// ------------------------------------------------------------------ //

export type MobileRadioState = 'idle' | 'fetching' | 'polling' | 'playing' | 'paused' | 'error';

export interface UseRadioReturn {
  // State
  radioState: MobileRadioState;
  // Mapped to RadioStatus for backward compat with RadioPlayer
  status: RadioStatus;
  currentTrack: Track | null;
  statusMessage: string;
  errorMessage: string | null;
  activityLog: ActivityEntry[];
  listenerCount: number;
  viewers: ViewerInfo[];
  audioDuration: number | null;
  progress: number;
  localPaused: boolean;
  // Actions
  tuneIn: () => void;
  tuneOut: () => Promise<void>;
  saveTrack: (trackId: string) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  seekBackward: () => Promise<void>;
  seekForward: () => Promise<void>;
  // DJ mode
  djLocked: boolean;
  djUnlockAt: number;
  activeDjName: string;
  djPanelOpen: boolean;
  claimDj: () => void;
  submitDj: (genres: string[], keywords: string[], language: string, feeling: string, djName: string) => void;
  closeDjPanel: () => void;
  // Reactions
  reactionState: ReactionState;
  react: (trackId: string, action: 'thumb_up' | 'thumb_down') => Promise<void>;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 16_000;
const POLL_INTERVAL_MS = 10_000;
// After a debounced duplicate track_ended, wait slightly longer than the 5s
// debounce window before retrying fetchAndPlay so the server has advanced.
const DEBOUNCE_RETRY_MS = 6_000;

export function useRadio(): UseRadioReturn {
  // ------------------------------------------------------------------ //
  // React state
  // ------------------------------------------------------------------ //
  const [radioState, setRadioStateRaw] = useState<MobileRadioState>('idle');
  const radioStateRef = useRef<MobileRadioState>('idle');
  const setRadioState = (s: MobileRadioState) => {
    radioStateRef.current = s;
    setRadioStateRaw(s);
  };

  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  const activityIdRef = useRef(0);
  const [progress, setProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [listenerCount, setListenerCount] = useState(0);
  const [viewers, setViewers] = useState<ViewerInfo[]>([]);
  const [localPaused, setLocalPaused] = useState(true);
  const localPausedRef = useRef(true);

  // DJ mode
  const [djLocked, setDjLocked] = useState(true);
  const [djUnlockAt, setDjUnlockAt] = useState(0);
  const [activeDjName, setActiveDjName] = useState('');
  const [djPanelOpen, setDjPanelOpen] = useState(false);

  // Reactions
  const emptyReaction: ReactionState = { thumbUp: 0, thumbDown: 0, userReaction: null };
  const [reactionState, setReactionState] = useState<ReactionState>(emptyReaction);
  const reactionStateRef = useRef<ReactionState>(emptyReaction);

  // ------------------------------------------------------------------ //
  // Refs (no re-render)
  // ------------------------------------------------------------------ //
  const currentTrackIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFetchingRef = useRef(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActiveRef = useRef(false);
  const isBackgroundRef = useRef(false);
  const playerReadyRef = useRef(false);

  // playbackStatusUpdate subscription — stored so we can remove it in background
  // to eliminate 500 ms JS wakeups (expo-audio fires this every updateInterval).
  // didJustFinish still arrives via AVPlayerItemDidPlayToEndTime notification.
  const playerSubRef = useRef<{ remove: () => void } | null>(null);
  // Backup timeout for track-end detection when the listener is suspended.
  const bgTrackEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // expo-audio player refs
  const playerRef = useRef<AudioPlayer | null>(null);        // active music player
  const silencePlayerRef = useRef<AudioPlayer | null>(null); // silence bridge
  const isBridgingRef = useRef(false);                       // silence bridge active?
  const bgStatusCleanupRef = useRef<(() => void) | null>(null); // Android: cancel in-flight native status fetch listener

  // ------------------------------------------------------------------ //
  // expo-audio setup
  // ------------------------------------------------------------------ //
  useEffect(() => {
    const mode = {
      playsInSilentMode: true,
      shouldPlayInBackground: true,
//      interruptionMode: 'doNotMix' as const,
      interruptionMode: 'doNotMix' as InterruptionMode,
      allowsRecording: false,
    };
//    console.log('[Audio] Calling setAudioModeAsync:', JSON.stringify(mode));
    setAudioModeAsync(mode).then(() => {
      playerReadyRef.current = true;
      console.log('[Audio] ✅ setAudioModeAsync resolved — playsInSilentMode:true shouldPlayInBackground:true interruptionMode:doNotMix');
    }).catch((err: Error) => {
      console.error('[Audio] ❌ setAudioModeAsync FAILED:', err);
    });
  }, []);

  // ------------------------------------------------------------------ //
  // Progress polling
  // ------------------------------------------------------------------ //
  // Progress timer — stopped in background so JS doesn't wake every 500 ms
  // while the UI is invisible (iOS terminates apps that run JS timers
  // after the ~30 s background grace window).
  // ------------------------------------------------------------------ //
  const startProgressTimer = useCallback(() => {
    if (progressTimerRef.current) return;
    progressTimerRef.current = setInterval(() => {
      if (!playerReadyRef.current || isBridgingRef.current) return;
      const p = playerRef.current;
      if (!p) return;
      try {
        const dur = p.duration;
        const pos = p.currentTime;
        if (dur > 0) {
          setProgress(pos / dur);
          setAudioDuration(Math.round(dur));
        }
      } catch {
        // Player not ready or no track loaded
      }
    }, 500);
  }, []);

  const stopProgressTimer = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    startProgressTimer();
    return () => stopProgressTimer();
  }, [startProgressTimer, stopProgressTimer]);

  // ------------------------------------------------------------------ //
  // Internal helpers
  // ------------------------------------------------------------------ //

  const sendWS = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    } else {
      console.warn('[WS] Cannot send — socket not open');
    }
  }, []);

  const sendTrackEnded = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: 'track_ended' }));
      console.log('[Radio] track_ended sent via WS');
      return;
    }
    // Android background: native module already fired track-ended — skip JS fetch which hangs in Doze.
    if (Platform.OS === 'android' && isBackgroundRef.current) {
      console.log('[Radio] track_ended skipped — already sent via native module (Android bg)');
      return;
    }
    // HTTP fallback when WS is dead (always in background mode)
    console.log('[Radio] track_ended via HTTP (bg:', isBackgroundRef.current, ')');
    try {
      const r = await fetch(`${BACKEND_URL}/api/radio/track-ended`, { method: 'POST' });
      console.log('[Radio] track_ended HTTP response:', r.status);
    } catch (err) {
      console.warn('[Radio] HTTP track-ended failed:', err);
    }
  }, []);

  const fetchReactions = useCallback((trackId: string) => {
    const resetReaction: ReactionState = { thumbUp: 0, thumbDown: 0, userReaction: null };
    setReactionState(resetReaction);
    reactionStateRef.current = resetReaction;
    fetch(`${BACKEND_URL}/api/tracks/${trackId}/reactions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { thumb_up: number; thumb_down: number; userReaction: string | null } | null) => {
        if (data) {
          const fetched: ReactionState = {
            thumbUp: data.thumb_up,
            thumbDown: data.thumb_down,
            userReaction: data.userReaction as ReactionState['userReaction'],
          };
          setReactionState(fetched);
          reactionStateRef.current = fetched;
        }
      })
      .catch(() => {});
  }, []);

  // ------------------------------------------------------------------ //
  // Silence bridge
  // ------------------------------------------------------------------ //

  const startSilenceBridge = useCallback(() => {
    if (isBridgingRef.current) return;
    isBridgingRef.current = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
//      console.log('[Audio] Creating silence player (keepAudioSessionActive:true, loop:true)');
      const s = createAudioPlayer(require('../../assets/silence.mp3'),
        {
          keepAudioSessionActive: true,
          updateInterval: 60_000,
         });
      s.loop = true;
      s.play();
      silencePlayerRef.current = s;
      console.log('[Radio] ✅ Silence bridge started — session kept active during download');
    } catch (err) {
      console.warn('[Radio] Failed to start silence bridge:', err);
      isBridgingRef.current = false;
    }
  }, []);

  const stopSilenceBridge = useCallback(() => {
    if (!isBridgingRef.current) return;
    isBridgingRef.current = false;
    try {
      silencePlayerRef.current?.pause();
      silencePlayerRef.current?.remove();
    } catch {}
    silencePlayerRef.current = null;
    console.log('[Radio] Silence bridge stopped');
  }, []);

  // ------------------------------------------------------------------ //
  // Platform-specific background strategies
  // ------------------------------------------------------------------ //

  /** Android-only: called when app enters background. Keeps playbackStatusUpdate
   *  listener alive (Android needs it for didJustFinish) and pre-starts the silence
   *  bridge so the foreground media service is uninterrupted through the transition. */
  const handleBackgroundAndroid = useCallback(() => {
    if (playerRef.current?.playing && !localPausedRef.current && !isBridgingRef.current) {
      startSilenceBridge();
      console.log('[BG] Android — silence bridge pre-started for service continuity');
    }
    console.log('[BG] Android — playbackStatusUpdate listener kept for track-end detection');
  }, [startSilenceBridge]);

  /** iOS-only: called when app enters background. Removes playbackStatusUpdate
   *  listener to stop 500 ms JS wakeups that trigger cpulimit kill. Sets a backup
   *  setTimeout near the expected track end (didJustFinish also arrives via
   *  AVPlayerItemDidPlayToEndTime, independent of the listener). */
  const handleBackgroundIOS = useCallback(() => {
    playerSubRef.current?.remove();
    playerSubRef.current = null;
    const bgPlayer = playerRef.current;
    if (bgPlayer && !localPausedRef.current) {
      const remaining = ((bgPlayer.duration ?? 0) - (bgPlayer.currentTime ?? 0)) * 1000;
      if (remaining > 0) {
        bgTrackEndTimerRef.current = setTimeout(() => {
          if (isBackgroundRef.current && !localPausedRef.current && !isFetchingRef.current) {
            console.log('[BG] track-end backup timer fired — calling handleTrackEnded');
            handleTrackEndedRef.current?.();
          }
        }, remaining + 3_000);
        console.log('[BG] iOS — listener suspended, backup timer set for', Math.round(remaining / 1000), 's');
      }
    } else {
      console.log('[BG] iOS — listener suspended (no active player)');
    }
  }, []);

  /** iOS-only: called when app returns to foreground. Re-attaches the
   *  playbackStatusUpdate listener that was removed on background. */
  const handleForegroundIOS = useCallback((wasBackground: boolean) => {
    if (!wasBackground || !playerRef.current || playerSubRef.current) return;
    let wasPlayingResume = playerRef.current.playing;
    playerSubRef.current = playerRef.current.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish) {
        console.log('[Audio] didJustFinish — bg:', isBackgroundRef.current, 'paused:', localPausedRef.current, 'fetching:', isFetchingRef.current);
        if (!localPausedRef.current) handleTrackEndedRef.current?.();
        return;
      }
      if (status.isLoaded && wasPlayingResume && !status.playing && !localPausedRef.current) {
        console.warn('[Audio] ⚠️ player stopped unexpectedly — bg:', isBackgroundRef.current, 'isBuffering:', status.isBuffering, 'pos:', status.currentTime?.toFixed(1), '/', status.duration?.toFixed(1));
      }
      if (status.isLoaded) wasPlayingResume = status.playing;
    });
    console.log('[BG] iOS — playbackStatusUpdate listener restored');
  }, []);

  /** Android-only: process the native BackgroundHttp.statusResult event.
   *  On success with a new track, calls fetchAndPlay(track) to reuse all
   *  download+play logic while skipping the frozen JS fetch. */
  const handleNativeStatusResult = useCallback((result: StatusResult) => {
    bgStatusCleanupRef.current = null;
    if (!result.ok) {
      console.warn('[BG/Android] native status fetch failed:', result.error, '— retrying in 5 s');
      isFetchingRef.current = false;
      // setTimeout is unreliable in Doze, but we're in a native-event wake window —
      // acceptable best-effort; foreground handleWake is the guaranteed fallback.
      setTimeout(() => { if (isBackgroundRef.current) handleTrackEndedRef.current?.(); }, 5_000);
      return;
    }
    let data: { currentTrack: Track | null; state: string };
    try {
      data = JSON.parse(result.body) as { currentTrack: Track | null; state: string };
    } catch {
      console.error('[BG/Android] failed to parse status response');
      isFetchingRef.current = false;
      return;
    }
    if (!data.currentTrack) {
      console.log('[BG/Android] no track yet — retrying in 5 s');
      isFetchingRef.current = false;
      setTimeout(() => { if (isBackgroundRef.current) handleTrackEndedRef.current?.(); }, 5_000);
      return;
    }
    if (data.currentTrack.id === currentTrackIdRef.current) {
      console.log('[BG/Android] same track still active — retrying in 5 s');
      isFetchingRef.current = false;
      setTimeout(() => { if (isBackgroundRef.current) handleTrackEndedRef.current?.(); }, 5_000);
      return;
    }
    // New track — hand off to fetchAndPlay with the prefetched track data.
    // fetchAndPlay will skip the status HTTP fetch and go straight to download+play.
    isFetchingRef.current = false; // fetchAndPlay re-acquires the mutex
    console.log('[BG/Android] new track received —', data.currentTrack.songTitle, '— handing to fetchAndPlay');
    fetchAndPlayRef.current?.(data.currentTrack);
  }, []);

  /** Android-only: track-ended path for background mode.
   *  Uses native HTTP (BackgroundHttpModule) instead of JS fetch() which hangs in Doze. */
  const handleTrackEndedAndroid = useCallback(() => {
    if (localPausedRef.current || isFetchingRef.current) return;
    isFetchingRef.current = true;
    startSilenceBridge(); // ensure bridge is running (may already be from background entry)
    sendTrackEndedNative(`${BACKEND_URL}/api/radio/track-ended`); // fire-and-forget
    setRadioState('fetching');
    setStatusMessage('Loading track...');
    const requestId = Date.now().toString();
    console.log('[BG/Android] fetchStatus via native module — requestId:', requestId);
    const cleanup = fetchStatusNative(
      `${BACKEND_URL}/api/radio/status`,
      requestId,
      handleNativeStatusResult,
    );
    bgStatusCleanupRef.current = cleanup;
  }, [handleNativeStatusResult, startSilenceBridge]);

  // ------------------------------------------------------------------ //
  // Polling
  // ------------------------------------------------------------------ //

  // Use a ref to hold the latest fetchAndPlay to break the circular dep
  // between startPolling and fetchAndPlay.
  const fetchAndPlayRef = useRef<((prefetchedTrack?: Track) => Promise<void>) | undefined>(undefined);

  // Ref for handleTrackEnded so the playbackStatusUpdate listener always calls the latest version
  const handleTrackEndedRef = useRef<(() => void) | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      console.log('[Radio] Polling stopped');
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    console.log('[Radio] Starting poll (10s interval)');
    setRadioState('polling');
    setStatusMessage('Waiting for radio...');
    pollTimerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/radio/status`);
        if (!res.ok) return;
        const data = await res.json() as { currentTrack: Track | null };
        if (data.currentTrack && data.currentTrack.id !== currentTrackIdRef.current) {
          console.log('[Radio] Poll: track available —', data.currentTrack.songTitle);
          stopPolling();
          fetchAndPlayRef.current?.();
        }
      } catch {
        // Network error — keep polling
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling]);

  // ------------------------------------------------------------------ //
  // Core: fetchAndPlay
  // ------------------------------------------------------------------ //

  // prefetchedTrack: Android background supplies this from native HTTP to skip JS fetch()
  const fetchAndPlay = useCallback(async (prefetchedTrack?: Track) => {
    console.log('[F&P] enter — bg:', isBackgroundRef.current, 'fetching:', isFetchingRef.current, 'paused:', localPausedRef.current, 'prefetched:', !!prefetchedTrack);
    if (isFetchingRef.current) {
      console.log('[F&P] mutex held, skipping');
      return;
    }
    isFetchingRef.current = true;
    setRadioState('fetching');
    setStatusMessage('Loading track...');
    setErrorMessage(null);

    try {
      let data: { currentTrack: Track | null; state: string };
      if (prefetchedTrack) {
        // Android background: track already fetched natively — skip JS fetch() which hangs in Doze
        data = { currentTrack: prefetchedTrack, state: 'playing' };
        console.log('[F&P] using prefetched track:', prefetchedTrack.id);
      } else {
        console.log('[F&P] GET /api/radio/status…');
        const res = await fetch(`${BACKEND_URL}/api/radio/status`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        data = await res.json() as { currentTrack: Track | null; state: string };
      }
      console.log('[F&P] status response — serverState:', data.state, 'trackId:', data.currentTrack?.id ?? 'null', 'currentLocal:', currentTrackIdRef.current);

      if (!data.currentTrack) {
        // No track yet — server still generating; poll
        console.log('[F&P] no track on server — starting poll');
        isFetchingRef.current = false;
        startPolling();
        return;
      }

      const track = data.currentTrack;

      // Duplicate guard: already playing this track
      if (currentTrackIdRef.current === track.id) {
        const isPlaying = (playerRef.current?.playing ?? false) || isBridgingRef.current;
        console.log('[F&P] same track', track.id, '— isPlaying:', isPlaying);
        isFetchingRef.current = false;
        if (isPlaying) {
          setRadioState('playing');
        } else {
          // Server is still on same track but player stopped — wait for server to advance
          console.log('[F&P] same track, player stopped — retrying after', DEBOUNCE_RETRY_MS, 'ms');
          setTimeout(() => fetchAndPlayRef.current?.(), DEBOUNCE_RETRY_MS);
        }
        return;
      }

      stopPolling();

      // Signal previous track ended — do this BEFORE resetting player so the
      // server has maximum time to generate the next track while we play.
      const hadPreviousTrack = currentTrackIdRef.current !== null;
      if (hadPreviousTrack) {
        await sendTrackEnded();
      }

      // Download audio to fixed local file
      console.log('[F&P] downloading', track.songTitle, '(bg:', isBackgroundRef.current, ')');
      const localUri = await downloadAudio(track);
      console.log('[F&P] download complete →', localUri);

      // Stop silence bridge and set up new AudioPlayer
      if (!playerReadyRef.current) throw new Error('Player not ready');
      stopSilenceBridge();

      // Tear down old player before creating new one
      playerRef.current?.remove();
      playerRef.current = null;

//      console.log('[Audio] Creating music player (keepAudioSessionActive:true) for:', track.songTitle);
      // updateInterval: 60_000 — we use our own startProgressTimer for UI
      // progress at 500 ms; didJustFinish arrives via AVPlayerItemDidPlayToEndTime
      // (a one-shot native notification) regardless of this interval, so track-end
      // detection is unaffected. A 60-second interval keeps the native timer
      // nearly silent in background instead of waking the bridge every 500 ms.
      const player = createAudioPlayer({ uri: localUri },
        { keepAudioSessionActive: true, updateInterval: 60_000 }
      );
      console.log('[Audio] ✅ Music player created — keepAudioSessionActive:true updateInterval:60s');

      // Detect track end via didJustFinish in status updates.
      // Store the subscription so we can remove it when backgrounding (to stop
      // 500 ms JS wakeups). didJustFinish is also delivered via a separate
      // AVPlayerItemDidPlayToEndTime path in expo-audio, independent of the
      // periodic updateInterval, so track-end detection survives even when the
      // subscription is suspended.
      playerSubRef.current?.remove();
      let wasPlaying = true;
      playerSubRef.current = player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) {
          console.log('[Audio] didJustFinish — bg:', isBackgroundRef.current, 'paused:', localPausedRef.current, 'fetching:', isFetchingRef.current);
          if (!localPausedRef.current) {
            handleTrackEndedRef.current?.();
          }
          return;
        }
        // Log unexpected stop — only after player is fully loaded to avoid
        // false positives from the initial buffering status event.
        if (status.isLoaded && wasPlaying && !status.playing && !localPausedRef.current) {
          console.warn(
            '[Audio] ⚠️ player stopped unexpectedly — bg:', isBackgroundRef.current,
            'playbackState:', (status as Record<string, unknown>).playbackState ?? '?',
            'isBuffering:', status.isBuffering,
            'pos:', status.currentTime?.toFixed(1), '/', status.duration?.toFixed(1)
          );
        }
        if (status.isLoaded) wasPlaying = status.playing;
      });

      // Register for lock screen controls (also required on Android for
      // sustained background playback beyond ~3 min)
//      console.log('[Audio] Calling setActiveForLockScreen(true) for:', track.songTitle);
      player.setActiveForLockScreen(true, {
        title: track.songTitle,
        artist: track.genre,
        albumTitle: 'Generative Radio',
      }, { showSeekForward: true, showSeekBackward: true });
      console.log('[Audio] ✅ setActiveForLockScreen done');

      playerRef.current = player;
      localPausedRef.current = false;
      setLocalPaused(false);
//      console.log('[Audio] Calling player.play() — track:', track.songTitle, 'duration:', track.duration);
      player.play();
      console.log('[Audio] ✅ player.play() called');

      currentTrackIdRef.current = track.id;
      setCurrentTrack(track);
      setRadioState('playing');
      setStatusMessage('');
      setProgress(0);
      setAudioDuration(null);
      fetchReactions(track.id);

    } catch (err) {
      console.error('[F&P] FAILED (bg:', isBackgroundRef.current, '):', err);
      setRadioState('error');
      setErrorMessage('Failed to load track — retrying...');
      isFetchingRef.current = false;
      setTimeout(() => fetchAndPlayRef.current?.(), 3_000);
      return;
    }

    isFetchingRef.current = false;
    console.log('[F&P] done — playing (bg:', isBackgroundRef.current, ')');
  }, [sendTrackEnded, startPolling, stopPolling, stopSilenceBridge, fetchReactions]);

  // Keep the refs in sync so polling and other callbacks always call the latest version
  useEffect(() => {
    fetchAndPlayRef.current = fetchAndPlay;
  }, [fetchAndPlay]);

  // ------------------------------------------------------------------ //
  // Track ended
  // ------------------------------------------------------------------ //

  const handleTrackEnded = useCallback(async () => {
    console.log('[Radio] handleTrackEnded — track:', currentTrackIdRef.current, 'bg:', isBackgroundRef.current, 'platform:', Platform.OS, 'paused:', localPausedRef.current, 'fetching:', isFetchingRef.current);
    if (localPausedRef.current) { console.log('[Radio] handleTrackEnded: skipped — paused'); return; }
    if (isFetchingRef.current) { console.log('[Radio] handleTrackEnded: skipped — already fetching'); return; }

    if (Platform.OS === 'android' && isBackgroundRef.current) {
      // Android background: JS fetch() hangs in Doze — use native HTTP module instead.
      handleTrackEndedAndroid();
    } else {
      // iOS (and Android foreground): standard path — silence bridge + JS fetch + play.
      startSilenceBridge();
      await sendTrackEnded();
      console.log('[Radio] handleTrackEnded — calling fetchAndPlay');
      await fetchAndPlay();
      console.log('[Radio] handleTrackEnded — fetchAndPlay returned');
    }
  }, [fetchAndPlay, handleTrackEndedAndroid, sendTrackEnded, startSilenceBridge]);

  // Keep ref in sync so the playbackStatusUpdate listener always calls latest
  useEffect(() => {
    handleTrackEndedRef.current = handleTrackEnded;
  }, [handleTrackEnded]);

  // ------------------------------------------------------------------ //
  // Wake from background
  // ------------------------------------------------------------------ //

  const handleWake = useCallback(async () => {
    const state = radioStateRef.current;
    console.log('[AppState] Wake — radioState:', state, 'localPaused:', localPausedRef.current);

    if (localPausedRef.current) return;

    switch (state) {
      case 'playing': {
        const active = (playerRef.current?.playing ?? false) || isBridgingRef.current;
        if (!active && playerReadyRef.current) {
          // Try a simple resume first (covers normal backgrounding)
          try { playerRef.current?.play(); } catch {}
          await new Promise<void>((r) => setTimeout(r, 1_000));
          const stillActive = (playerRef.current?.playing ?? false) || isBridgingRef.current;
          if (!stillActive) {
            console.log('[Wake] Player did not resume — re-fetching');
            await fetchAndPlay();
          }
        }
        break;
      }
      case 'fetching':
        // isFetchingRef may be stuck true from a fetch killed by iOS sleep
        if (isFetchingRef.current) {
          console.log('[Wake] Fetch was in-flight during sleep — resetting mutex + retrying');
          isFetchingRef.current = false;
          await fetchAndPlay();
        }
        break;
      case 'polling':
        // Poll interval was suspended by iOS; restart it
        stopPolling();
        startPolling();
        break;
      case 'error':
        await fetchAndPlay();
        break;
      case 'idle':
      case 'paused':
        break;
    }
  }, [fetchAndPlay, startPolling, stopPolling]);

  // ------------------------------------------------------------------ //
  // WebSocket
  // ------------------------------------------------------------------ //

  const connectWebSocket = useCallback(() => {
    if (!isActiveRef.current) return;
    console.log('[WS] Connecting to', WS_URL);

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      reconnectDelay.current = RECONNECT_BASE_MS;
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'ping' }));
        }
      }, 20_000);
    };

    ws.onmessage = (event: MessageEvent) => {
      // RN's native WS bridge can fire onmessage even after onmessage=null,
      // so guard here as the definitive backstop for background mode.
      if (isBackgroundRef.current) return;
      let msg: WSMessage;
      try {
        msg = JSON.parse(event.data as string) as WSMessage;
      } catch {
        console.error('[WS] Failed to parse message:', event.data);
        return;
      }
      console.log('[WS] Received:', msg.event);
/*
      // Heartbeat: log player state on every WS message so we can see
      // exactly when/why audio stops in background.
      {
        const p = playerRef.current;
        const appState = radioStateRef.current;
        if (p) {
          console.log(
            `[Audio] heartbeat — appState:${appState}` +
            ` playing:${p.playing} loaded:${p.isLoaded} buffering:${p.isBuffering}` +
            ` pos:${p.currentTime?.toFixed(1)}/${p.duration?.toFixed(1)}` +
            ` paused:${localPausedRef.current} bridging:${isBridgingRef.current}`
          );
        }
      }
*/
      if (msg.event === 'play_now') {
        // Backend watchdog — server thinks we should be playing.
        console.log('[WS] play_now received — triggering fetchAndPlay');
        if (!localPausedRef.current && !isFetchingRef.current) {
          fetchAndPlayRef.current?.();
        }
      } else if (msg.event === 'status') {
        const { message } = msg.data as unknown as StatusData;
        if (message) setStatusMessage(message);
      } else if (msg.event === 'progress') {
        const { stage, message } = msg.data as unknown as ProgressData;
        setActivityLog((prev) => [
          ...prev,
          { id: activityIdRef.current++, stage, message },
        ]);
      } else if (msg.event === 'listener_count') {
        const { count } = msg.data as unknown as ListenerCountData;
        setListenerCount(count);
      } else if (msg.event === 'viewer_list') {
        const { viewers: vl } = msg.data as unknown as ViewerListData;
        setViewers(vl);
      } else if (msg.event === 'error') {
        const { message } = msg.data as unknown as ErrorData;
        setErrorMessage(message);
      } else if (msg.event === 'dj_state') {
        const d = msg.data as unknown as DjStateData;
        setDjLocked(d.locked);
        setDjUnlockAt(d.unlockAt);
        setActiveDjName(d.activeDjName);
      } else if (msg.event === 'dj_claim_ack') {
        const { granted } = msg.data as unknown as DjClaimAckData;
        if (granted) setDjPanelOpen(true);
      } else if (msg.event === 'reaction_update') {
        const d = msg.data as unknown as ReactionUpdateData;
        if (currentTrackIdRef.current === d.trackId) {
          setReactionState((prev) => ({ ...prev, thumbUp: d.thumbUp, thumbDown: d.thumbDown }));
        }
      }
    };

    ws.onclose = () => {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (isActiveRef.current && !isBackgroundRef.current && wsRef.current === ws) {
        const delay = reconnectDelay.current;
        console.log(`[WS] Closed — reconnecting in ${delay}ms`);
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(delay * 2, RECONNECT_MAX_MS);
          connectWebSocket();
        }, delay);
      }
    };

    ws.onerror = () => {
      console.error('[WS] Socket error');
    };
  }, []);

  // Mount: connect WS and immediately start fetching (always-viewer)
  useEffect(() => {
    isActiveRef.current = true;
    connectWebSocket();
    // Start fetching on mount — backend auto-starts with RANDOM if idle
    fetchAndPlayRef.current?.();
    return () => {
      isActiveRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      wsRef.current?.close();
      stopPolling();
    };
  }, [connectWebSocket, stopPolling]);

  // AppState: handle foreground/background transitions
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const p = playerRef.current;
      const playerSnap = p
        ? `playing:${p.playing} pos:${p.currentTime?.toFixed(1)}/${p.duration?.toFixed(1)}`
        : 'no player';
      console.log(`[AppState] ${nextState} — ${playerSnap} bridging:${isBridgingRef.current}`);
      if (nextState === 'inactive') {
        // iOS fires 'inactive' right before 'background' (and again on the
        // way back to 'active'). Close the WS here — the app still has full
        // network access so the TCP close handshake completes in foreground.
        // The server stops sending messages before we enter background, which
        // prevents the native WS module from waking the JS thread and causing
        // a cpulimit violation that kills the app.
        if (wsRef.current) {
          const dyingWs = wsRef.current;
          wsRef.current = null;
          dyingWs.onclose = null; // suppress auto-reconnect from the close handler
          dyingWs.close();
          console.log('[WS] Inactive — closing socket cleanly');
        }
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
      } else if (nextState === 'active') {
        const wasBackground = isBackgroundRef.current;
        isBackgroundRef.current = false;
        startProgressTimer();
        // Cancel backup track-end timer.
        if (bgTrackEndTimerRef.current) {
          clearTimeout(bgTrackEndTimerRef.current);
          bgTrackEndTimerRef.current = null;
        }
        // Cancel any in-flight native status fetch listener (Android).
        bgStatusCleanupRef.current?.();
        bgStatusCleanupRef.current = null;
        // iOS: re-attach playbackStatusUpdate listener removed on background entry.
        // Android: listener was never removed, so this is a no-op there.
        if (Platform.OS === 'ios') handleForegroundIOS(wasBackground);
        // Reconnect WS (closed in 'inactive' on iOS, 'background' on Android).
        if (wsRef.current === null) connectWebSocket();
        handleWake();
      } else if (nextState === 'background') {
        isBackgroundRef.current = true;
        // Android has no 'inactive' state, so WS may still be open here.
        // On iOS wsRef is already null (closed in 'inactive'), so this is a no-op.
        if (wsRef.current) {
          const dyingWs = wsRef.current;
          wsRef.current = null;
          dyingWs.onclose = null;
          dyingWs.close();
          console.log('[WS] Background — closing socket (Android path)');
        }
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
        stopPolling();
        stopProgressTimer();
        // Platform-specific background entry logic.
        if (Platform.OS === 'ios') {
          handleBackgroundIOS();
        } else {
          handleBackgroundAndroid();
        }
      }
    });
    return () => sub.remove();
  }, [handleWake, stopPolling, connectWebSocket, startProgressTimer, stopProgressTimer, handleBackgroundIOS, handleBackgroundAndroid, handleForegroundIOS]);

  // ------------------------------------------------------------------ //
  // Public API
  // ------------------------------------------------------------------ //

  const tuneIn = useCallback(() => {
    setErrorMessage(null);
    setActivityLog([]);
    localPausedRef.current = false;
    setLocalPaused(false);
    isFetchingRef.current = false;
    fetchAndPlayRef.current?.();
  }, []);

  const tuneOut = useCallback(async () => {
    stopPolling();
    isFetchingRef.current = false;
    currentTrackIdRef.current = null;
    setRadioState('idle');
    setCurrentTrack(null);
    setProgress(0);
    setLocalPaused(true);
    localPausedRef.current = true;
    playerSubRef.current?.remove();
    playerSubRef.current = null;
    if (bgTrackEndTimerRef.current) {
      clearTimeout(bgTrackEndTimerRef.current);
      bgTrackEndTimerRef.current = null;
    }
    stopSilenceBridge();
    if (playerReadyRef.current) {
      try {
        playerRef.current?.clearLockScreenControls();
        playerRef.current?.pause();
        playerRef.current?.remove();
        playerRef.current = null;
      } catch {}
    }
  }, [stopPolling, stopSilenceBridge]);

  const saveTrack = useCallback(async (trackId: string): Promise<void> => {
    const res = await fetch(`${BACKEND_URL}/api/tracks/${trackId}/save`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error((err as { detail?: string }).detail ?? 'Save failed');
    }
  }, []);

  const claimDj = useCallback(() => sendWS({ event: 'dj_claim' }), [sendWS]);

  const submitDj = useCallback((
    genres: string[], keywords: string[],
    language: string, feeling: string, djName: string,
  ) => {
    setDjPanelOpen(false);
    sendWS({ event: 'dj_submit', data: { genres, keywords, language, feeling, djName } });
  }, [sendWS]);

  const closeDjPanel = useCallback(() => setDjPanelOpen(false), []);

  const react = useCallback(async (trackId: string, action: 'thumb_up' | 'thumb_down'): Promise<void> => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/tracks/${trackId}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) return;
      const data = await res.json() as { thumb_up: number; thumb_down: number; userReaction: string | null };
      setReactionState((prev) => ({
        ...prev,
        thumbUp: data.thumb_up,
        thumbDown: data.thumb_down,
        userReaction: data.userReaction as ReactionState['userReaction'],
      }));
    } catch (err) {
      console.error('[Reactions] React failed:', err);
    }
  }, []);

  const togglePlayPause = useCallback(async () => {
    if (!playerReadyRef.current) return;
    const p = playerRef.current;
    if (!p) return;
    try {
      if (p.playing) {
        p.pause();
        setLocalPaused(true);
        localPausedRef.current = true;
        setRadioState('paused');
      } else {
        p.play();
        setLocalPaused(false);
        localPausedRef.current = false;
        setRadioState('playing');
      }
    } catch (err) {
      console.error('[Audio] togglePlayPause failed:', err);
    }
  }, []);

  const seekBackward = useCallback(async () => {
    if (!playerReadyRef.current) return;
    const p = playerRef.current;
    if (!p) return;
    try {
      await p.seekTo(Math.max(0, p.currentTime - 10));
    } catch {}
  }, []);

  const seekForward = useCallback(async () => {
    if (!playerReadyRef.current) return;
    const p = playerRef.current;
    if (!p) return;
    try {
      await p.seekTo(Math.min(p.duration ?? 0, p.currentTime + 10));
    } catch {}
  }, []);

  // ------------------------------------------------------------------ //
  // Derive RadioStatus for backward compat with RadioPlayer component
  // ------------------------------------------------------------------ //
  const status: RadioStatus = (() => {
    switch (radioState) {
      case 'idle':     return 'idle';
      case 'fetching': return 'buffering';
      case 'polling':  return 'generating';
      case 'playing':  return 'playing';
      case 'paused':   return 'playing';
      case 'error':    return 'stopped';
    }
  })();

  return {
    radioState, status,
    currentTrack, statusMessage, errorMessage,
    activityLog, listenerCount, viewers,
    audioDuration, progress, localPaused,
    tuneIn, tuneOut, saveTrack,
    togglePlayPause, seekBackward, seekForward,
    djLocked, djUnlockAt, activeDjName, djPanelOpen,
    claimDj, submitDj, closeDjPanel,
    reactionState, react,
  };
}
