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
  RoleAssignedData,
  ReactionState,
  ReactionUpdateData,
} from '@radio/shared';
import { BACKEND_URL, wsUrl } from '../config';
import { downloadAudio, cancelCurrentDownload } from '../utils/downloadAudio';
import { fetchStatusNative, sendTrackEndedNative } from '../modules/backgroundHttp';
import type { StatusResult } from '../modules/backgroundHttp';
import {
  OfflineTrackMeta,
  offlineTrackUri,
  metaToTrack,
  shuffled,
  scanOfflineTracks,
  cleanupStagingDir,
  isOfflineModePersisted,
  setOfflineModePersisted,
} from '../utils/offlineLibrary';

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
  /** True iff this WS connection is authenticated — DJ mode is members-only.
   *  Comes from role_assigned, so it reflects what the *server* sees, not just
   *  whether we hold a token locally. */
  djAvailable: boolean;
  /** The signed-in nickname the server will attribute a DJ session to. */
  djNickname: string;
  /** Why the last DJ claim was refused, when the reason needs explaining.
   *  'locked' is already covered by the on-screen countdown, so it is not
   *  reported here. Cleared on the next role_assigned. */
  djClaimRefusal: 'auth_required' | 'session_expired' | null;
  clearDjClaimRefusal: () => void;
  claimDj: () => void;
  submitDj: (genres: string[], keywords: string[], language: string, feeling: string) => void;
  closeDjPanel: () => void;
  // Reactions
  reactionState: ReactionState;
  react: (trackId: string, action: 'thumb_up' | 'thumb_down') => Promise<void>;
  // Offline mode
  offlineMode: boolean;
  offlineTrackCount: number;
  enterOfflineMode: (tracks: OfflineTrackMeta[]) => void;
  /** Async: it first checks the server is reachable and refuses (leaving
   *  offline mode intact) when it is not. */
  exitOfflineMode: () => Promise<void>;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 16_000;
const POLL_INTERVAL_MS = 10_000;
// After a debounced duplicate track_ended, wait slightly longer than the 5s
// debounce window before retrying fetchAndPlay so the server has advanced.
const DEBOUNCE_RETRY_MS = 6_000;
// iOS background-start: how long the silence bridge + status polling may keep
// the app alive in background while waiting for the FIRST track. App Review
// guideline 2.5.4 disallows indefinite silent background audio — keep this
// bounded; the bridge is a short ramp into imminent real playback.
const BG_FIRST_TRACK_WAIT_CAP_MS = 10 * 60_000;
// A fetchAndPlay run older than this is considered a zombie (iOS suspended the
// JS thread mid-await and never resumed it); play_now may break its mutex.
const FETCH_STUCK_MS = 120_000;
// Upper bound on any library track. Backs the offline background watchdog, the
// last line of defence when both didJustFinish and the duration timer are gone.
const MAX_TRACK_MS = 6 * 60_000;
// How long to wait for the server before deciding we are still offline.
const REACHABILITY_TIMEOUT_MS = 4_000;

export interface RadioAuthInput {
  /** Bearer JWT from useAuth, or null when signed out. */
  token: string | null;
  /** Bumped by useAuth on every sign-in / sign-out. Changing it reconnects the
   *  WebSocket so the server re-evaluates identity on the new connection. */
  authVersion: number;
}

export function useRadio(
  { token, authVersion }: RadioAuthInput = { token: null, authVersion: 0 },
): UseRadioReturn {
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
  const [djAvailable, setDjAvailable] = useState(false);
  const [djNickname, setDjNickname] = useState('');
  const [djClaimRefusal, setDjClaimRefusal] =
    useState<'auth_required' | 'session_expired' | null>(null);

  // Reactions
  const emptyReaction: ReactionState = { thumbUp: 0, thumbDown: 0, userReaction: null };
  const [reactionState, setReactionState] = useState<ReactionState>(emptyReaction);
  const reactionStateRef = useRef<ReactionState>(emptyReaction);

  // Offline mode
  const [offlineMode, setOfflineModeState] = useState(false);
  const offlineModeRef = useRef(false);
  const setOfflineMode = (v: boolean) => { offlineModeRef.current = v; setOfflineModeState(v); };
  const [offlineTrackCount, setOfflineTrackCount] = useState(0);

  // ------------------------------------------------------------------ //
  // Refs (no re-render)
  // ------------------------------------------------------------------ //
  const currentTrackIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFetchingRef = useRef(false);
  // Monotonic epoch for fetchAndPlay runs. Bumping it invalidates suspended
  // continuations of older runs (iOS can freeze an async fn mid-await for
  // minutes and resume it after wake) so they can't clobber newer state.
  const fetchEpochRef = useRef(0);
  const fetchStartedAtRef = useRef(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActiveRef = useRef(false);
  const isBackgroundRef = useRef(false);
  // connectWebSocket has no dependencies (it must not be re-created on every
  // render), so it reads the live token from a ref rather than closing over it.
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;
  const playerReadyRef = useRef(false);

  // playbackStatusUpdate subscription — stored so we can remove it in background
  // to eliminate 500 ms JS wakeups (expo-audio fires this every updateInterval).
  // didJustFinish still arrives via AVPlayerItemDidPlayToEndTime notification.
  const playerSubRef = useRef<{ remove: () => void } | null>(null);
  // Backup timeout for track-end detection when the listener is suspended.
  const bgTrackEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cap timer for the iOS background first-track wait (silence bridge + polling).
  const bgWaitCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Offline background watchdog — fires only if nothing else advanced the queue.
  const bgWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // expo-audio player refs
  const playerRef = useRef<AudioPlayer | null>(null);        // active music player
  const silencePlayerRef = useRef<AudioPlayer | null>(null); // silence bridge
  const isBridgingRef = useRef(false);                       // silence bridge active?
  const bgStatusCleanupRef = useRef<(() => void) | null>(null); // Android: cancel in-flight native status fetch listener

  // Offline playback refs
  const offlineTracksRef   = useRef<Map<string, OfflineTrackMeta>>(new Map()); // id → meta
  const offlineQueueRef    = useRef<string[]>([]);   // shuffled ids
  const offlineQueuePosRef = useRef(-1);             // index of currently playing entry
  // Tracks staged by mount for an offline resume, consumed once the audio
  // session is ready. enterOfflineMode is a useCallback defined much further
  // down, so it is reached through a ref.
  const pendingOfflineResumeRef = useRef<OfflineTrackMeta[] | null>(null);
  const enterOfflineModeRef = useRef<((t: OfflineTrackMeta[]) => void) | null>(null);

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
      // Offline resume waits here rather than running at mount: enterOfflineMode
      // refuses to touch anything until the audio session exists, so firing it
      // earlier would silently do nothing and leave the app on a dead screen.
      const resume = pendingOfflineResumeRef.current;
      if (resume) {
        pendingOfflineResumeRef.current = null;
        enterOfflineModeRef.current?.(resume);
      }
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
    // Every bridge teardown also cancels the background first-track wait cap.
    if (bgWaitCapTimerRef.current) {
      clearTimeout(bgWaitCapTimerRef.current);
      bgWaitCapTimerRef.current = null;
    }
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
  // Shared playbackStatusUpdate listener (online + offline players)
  // ------------------------------------------------------------------ //

  const attachStatusListener = useCallback((player: AudioPlayer) => {
    playerSubRef.current?.remove();
    let wasPlaying = player.playing;
    playerSubRef.current = player.addListener('playbackStatusUpdate', (status) => {
      if (status.playbackState === 'failed') {
        if (localPausedRef.current || isFetchingRef.current) return;
        if (offlineModeRef.current) {
          // Corrupt/missing local file — drop it from the pool and advance.
          console.error('[Offline] playback failed — skipping track', currentTrackIdRef.current);
          dropOfflineTrack(currentTrackIdRef.current);
          playNextOfflineRef.current?.();
        } else {
          console.error('[Audio] playbackState=failed — re-downloading current track');
          currentTrackIdRef.current = null;
          setRadioState('error');
          setErrorMessage('Playback failed — recovering...');
          fetchAndPlayRef.current?.();
        }
        return;
      }
      if (status.didJustFinish) {
        console.log('[Audio] didJustFinish — bg:', isBackgroundRef.current, 'paused:', localPausedRef.current, 'fetching:', isFetchingRef.current, 'offline:', offlineModeRef.current);
        if (!localPausedRef.current) handleTrackEndedRef.current?.();
        return;
      }
      // Detect external pause/resume caused by the media widget (Android MediaSession
      // or iOS lock-screen controls) which update native state without going through JS.
      // Sync localPausedRef so togglePlayPause(), handleWake(), and didJustFinish guards
      // all see consistent intent state.
      if (status.isLoaded && wasPlaying && !status.playing && !localPausedRef.current) {
        if (status.isBuffering) {
          // Momentary pause while buffering — not an external stop.
          console.warn(
            '[Audio] ⚠️ player buffering — bg:', isBackgroundRef.current,
            'pos:', status.currentTime?.toFixed(1), '/', status.duration?.toFixed(1)
          );
        } else {
          // Widget (or OS) paused/stopped the player externally — sync JS intent.
          console.log(
            '[Audio] Player stopped externally (widget/OS) — syncing pause state',
            'bg:', isBackgroundRef.current,
            'playbackState:', (status as Record<string, unknown>).playbackState ?? '?'
          );
          localPausedRef.current = true;
          setLocalPaused(true);
          setRadioState('paused');
        }
      }
      // Detect external resume: widget played while user-intent was paused.
      if (status.isLoaded && !wasPlaying && status.playing && localPausedRef.current) {
        console.log('[Audio] Player resumed externally (widget/OS) — syncing play state');
        localPausedRef.current = false;
        setLocalPaused(false);
        setRadioState('playing');
      }
      if (status.isLoaded) wasPlaying = status.playing;
    });
  }, []);

  // ------------------------------------------------------------------ //
  // Platform-specific background strategies
  // ------------------------------------------------------------------ //

  /** Android-only: called when app enters background. Keeps playbackStatusUpdate
   *  listener alive (Android needs it for didJustFinish) and pre-starts the silence
   *  bridge so the foreground media service is uninterrupted through the transition. */
  const handleBackgroundAndroid = useCallback(() => {
    // Offline playback needs no service-continuity bridge (zero network); a
    // bridge left running would set isBridgingRef=true and freeze the progress
    // UI (startProgressTimer skips ticks while bridging) until the next track.
    if (!offlineModeRef.current && playerRef.current?.playing && !localPausedRef.current && !isBridgingRef.current) {
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

  /** The one and only way to dispose of the music player.
   *
   *  expo-audio's `remove()` does NOT stop playback — on both platforms it only
   *  drops the object from the module's registry (ios/AudioModule.swift:251,
   *  android/.../AudioModule.kt:494), leaving the native player decoding. So an
   *  un-paused `remove()` followed by a new `createAudioPlayer()` yields two
   *  audible streams. `pause()` is what actually stops it.
   *
   *  The ref is nulled *first* so a re-entrant call (e.g. a status listener
   *  firing during teardown) cannot tear the same player down twice, and each
   *  native call is isolated so one throwing cannot skip the rest.
   *
   *  TODO: `AudioPlayer` extends `SharedObject`, so `release()` exists and would
   *  force deterministic native teardown — but it makes every later call on the
   *  object throw and interacts badly with the status-listener lifecycle.
   *  `pause()` is sufficient here. */
  const teardownPlayer = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (!player) return;
    try { player.clearLockScreenControls(); } catch {}
    try { player.pause(); } catch {}
    try { player.remove(); } catch {}
  }, []);

  /** iOS-only: called when app returns to foreground. Re-attaches the
   *  playbackStatusUpdate listener that was removed on background. */
  const handleForegroundIOS = useCallback((wasBackground: boolean) => {
    if (!wasBackground || !playerRef.current || playerSubRef.current) return;
    attachStatusListener(playerRef.current);
    console.log('[BG] iOS — playbackStatusUpdate listener restored');
  }, [attachStatusListener]);

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
    // Stamp the mutex acquisition so the play_now stuck-mutex escape judges
    // this native fetch by its real age, not a previous run's timestamp.
    fetchStartedAtRef.current = Date.now();
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
  // Offline playback
  // ------------------------------------------------------------------ //

  const playNextOfflineRef = useRef<(() => void) | null>(null);

  const dropOfflineTrack = (id: string | null) => {
    if (!id) return;
    offlineTracksRef.current.delete(id);
    // The queue position is an index, so removing an entry at or before it
    // shifts every later entry down by one and the position now names a
    // different track. Left uncorrected, each dropped track silently skipped a
    // perfectly good one as well.
    const idx = offlineQueueRef.current.indexOf(id);
    offlineQueueRef.current = offlineQueueRef.current.filter((x) => x !== id);
    if (idx !== -1 && idx <= offlineQueuePosRef.current) offlineQueuePosRef.current -= 1;
    if (offlineQueuePosRef.current >= offlineQueueRef.current.length) offlineQueuePosRef.current = -1;
    setOfflineTrackCount(offlineTracksRef.current.size);
  };

  const playOfflineTrack = useCallback((meta: OfflineTrackMeta) => {
    stopSilenceBridge();                                  // never bridge offline
    // Tear down BEFORE the readiness bail-out: returning early with the online
    // player still decoding is what made online and offline audio overlap.
    teardownPlayer();
    if (!playerReadyRef.current) return;

    const player = createAudioPlayer(
      { uri: offlineTrackUri(meta.trackId) },
      { keepAudioSessionActive: true, updateInterval: 60_000 },  // identical to online
    );
    attachStatusListener(player);                          // also tears down the old subscription
    player.setActiveForLockScreen(true, {
      title: meta.songTitle ?? 'Unknown Track',
      artist: meta.genreLabel ?? 'Offline',
      albumTitle: 'Generative Radio — Offline',
    }, { showSeekForward: true, showSeekBackward: true });

    playerRef.current = player;
    localPausedRef.current = false; setLocalPaused(false);
    player.play();

    currentTrackIdRef.current = meta.trackId;
    setCurrentTrack(metaToTrack(meta));
    setRadioState('playing');
    setStatusMessage(`Offline mode — ${offlineTracksRef.current.size} tracks`);
    setErrorMessage(null);
    setProgress(0);
    setAudioDuration(meta.duration ?? null);

    // Mirror fetchAndPlay's iOS bg-transition block: when a new track starts
    // while backgrounded, suspend the listener and arm a duration-based backup
    // timer (didJustFinish delivery is unreliable in throttled bg JS).
    if (Platform.OS === 'ios' && isBackgroundRef.current) {
      if (bgTrackEndTimerRef.current) clearTimeout(bgTrackEndTimerRef.current);
      // A sidecar written before durations were recorded has none, and the
      // player has not loaded far enough to report one yet either. Previously
      // that produced ms === 0, no backup timer — and the listener had already
      // been removed, so the track ended in the background with no route back
      // and playback simply stopped for good.
      const seconds = meta.duration ?? player.duration ?? 0;
      const ms = seconds * 1000;
      if (ms > 0) {
        playerSubRef.current?.remove(); playerSubRef.current = null;
        bgTrackEndTimerRef.current = setTimeout(() => {
          if (isBackgroundRef.current && !localPausedRef.current && !isFetchingRef.current) {
            handleTrackEndedRef.current?.();
          }
        }, ms + 3_000);
      } else {
        // No duration to time against: keep the listener attached so
        // didJustFinish stays as the one remaining route, matching what the
        // online path does when it cannot arm a timer. Costs background
        // wakeups; silence costs the whole session.
        console.warn('[Offline] no duration for', meta.trackId, '— keeping the status listener as the only track-end route');
      }
      // Last resort either way: no track in this library runs longer than this,
      // so a missed end cannot strand playback indefinitely.
      if (bgWatchdogRef.current) clearTimeout(bgWatchdogRef.current);
      bgWatchdogRef.current = setTimeout(() => {
        if (isBackgroundRef.current && !localPausedRef.current && !isFetchingRef.current) {
          console.warn('[Offline] max-track watchdog fired — advancing');
          handleTrackEndedRef.current?.();
        }
      }, MAX_TRACK_MS);
    }
  }, [attachStatusListener, stopSilenceBridge, teardownPlayer]);

  const playNextOffline = useCallback(() => {
    const tracks = offlineTracksRef.current;
    if (tracks.size === 0) {
      setRadioState('error');
      setErrorMessage('No offline tracks available');
      return;
    }
    let queue = offlineQueueRef.current;
    offlineQueuePosRef.current += 1;
    if (offlineQueuePosRef.current >= queue.length) {
      // Exhausted → reshuffle; avoid immediate repeat of the last-played id.
      const lastPlayed = currentTrackIdRef.current;
      queue = shuffled([...tracks.keys()]);
      if (queue.length > 1 && queue[0] === lastPlayed) {
        const j = 1 + Math.floor(Math.random() * (queue.length - 1));
        [queue[0], queue[j]] = [queue[j], queue[0]];
      }
      offlineQueueRef.current = queue;
      offlineQueuePosRef.current = 0;
    }
    const meta = tracks.get(queue[offlineQueuePosRef.current]);
    if (!meta) { playNextOfflineRef.current?.(); return; }       // id evaporated — advance (bounded: queue shrank)
    try {
      playOfflineTrack(meta);
    } catch (err) {
      console.error('[Offline] play failed for', meta.trackId, err);
      dropOfflineTrack(meta.trackId);
      if (offlineTracksRef.current.size > 0) playNextOfflineRef.current?.();
      else { setRadioState('error'); setErrorMessage('No playable offline tracks'); }
    }
  }, [playOfflineTrack]);
  useEffect(() => { playNextOfflineRef.current = playNextOffline; }, [playNextOffline]);

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
    if (offlineModeRef.current) return;
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
    if (offlineModeRef.current) { console.log('[F&P] offline — skipping'); return; }
    console.log('[F&P] enter — bg:', isBackgroundRef.current, 'fetching:', isFetchingRef.current, 'paused:', localPausedRef.current, 'prefetched:', !!prefetchedTrack);
    if (isFetchingRef.current) {
      console.log('[F&P] mutex held, skipping');
      return;
    }
    isFetchingRef.current = true;
    const epoch = ++fetchEpochRef.current;
    fetchStartedAtRef.current = Date.now();
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
        if (epoch !== fetchEpochRef.current) { console.log('[F&P] stale epoch — aborting'); return; }
        if (!res.ok) throw new Error(`Status ${res.status}`);
        data = await res.json() as { currentTrack: Track | null; state: string };
        if (epoch !== fetchEpochRef.current) { console.log('[F&P] stale epoch — aborting'); return; }
      }
      console.log('[F&P] status response — serverState:', data.state, 'trackId:', data.currentTrack?.id ?? 'null', 'currentLocal:', currentTrackIdRef.current);

      if (!data.currentTrack) {
        // No track yet — server still generating; poll
        console.log('[F&P] no track on server — starting poll');
        isFetchingRef.current = false;
        // iOS pre-first-track: start the silence bridge now, while the app can
        // still activate an audio session (iOS cannot do that from background).
        // It keeps the app unsuspended if the user backgrounds before the
        // first track arrives. Trade-off: with interruptionMode 'doNotMix'
        // this stops other apps' audio at launch — accepted for an
        // auto-playing radio app. Gated on a null track ref so mid-session
        // behavior is unchanged; iOS-only because Android stops polling in
        // background anyway (its native fallbacks are mid-session only), so a
        // bridge would loop silence there for no benefit.
        if (Platform.OS === 'ios' && currentTrackIdRef.current === null) startSilenceBridge();
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
        if (epoch !== fetchEpochRef.current) { console.log('[F&P] stale epoch — aborting'); return; }
      }

      // Download audio to fixed local file
      console.log('[F&P] downloading', track.songTitle, '(bg:', isBackgroundRef.current, ')');
      const localUri = await downloadAudio(track);
      if (epoch !== fetchEpochRef.current) { console.log('[F&P] stale epoch — aborting'); return; }
      console.log('[F&P] download complete →', localUri);

      // Stop silence bridge and set up new AudioPlayer
      if (!playerReadyRef.current) throw new Error('Player not ready');
      stopSilenceBridge();

      // Tear down old player before creating new one
      teardownPlayer();

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

      // Detect track end via didJustFinish in status updates. Shared listener
      // (also used by offline playback) — see attachStatusListener above.
      attachStatusListener(player);

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

      // iOS background: undo the listener attachment above and set a fresh backup
      // timer for the new track. fetchAndPlay re-attaches the listener unconditionally,
      // but in background the listener causes JS wakeups and didJustFinish delivery
      // is unreliable once iOS throttles the JS bridge. The backup timer (same approach
      // as handleBackgroundIOS on initial background entry) is the only reliable
      // track-end signal for tracks 2, 3, … in a background session.
      if (Platform.OS === 'ios' && isBackgroundRef.current) {
        playerSubRef.current?.remove();
        playerSubRef.current = null;
        if (bgTrackEndTimerRef.current) {
          clearTimeout(bgTrackEndTimerRef.current);
          bgTrackEndTimerRef.current = null;
        }
        const trackDurationMs = (track.duration ?? 0) * 1000;
        if (trackDurationMs > 0) {
          bgTrackEndTimerRef.current = setTimeout(() => {
            if (isBackgroundRef.current && !localPausedRef.current && !isFetchingRef.current) {
              console.log('[BG] track-end backup timer (bg-transition) fired — calling handleTrackEnded');
              handleTrackEndedRef.current?.();
            }
          }, trackDurationMs + 3_000);
          console.log('[BG] iOS — listener re-suspended after bg-transition, backup timer set for', Math.round(trackDurationMs / 1000), 's');
        } else {
          console.warn('[BG] iOS — track.duration missing; didJustFinish is the only fallback');
        }
      }

    } catch (err) {
      // A stale (superseded) run's failure must not flip state or schedule retries.
      if (epoch !== fetchEpochRef.current) { console.log('[F&P] stale epoch — error ignored'); return; }
      console.error('[F&P] FAILED (bg:', isBackgroundRef.current, '):', err);
      setRadioState('error');
      setErrorMessage('Failed to load track — retrying...');
      isFetchingRef.current = false;
      setTimeout(() => fetchAndPlayRef.current?.(), 3_000);
      return;
    }

    isFetchingRef.current = false;
    console.log('[F&P] done — playing (bg:', isBackgroundRef.current, ')');
  }, [sendTrackEnded, startPolling, stopPolling, startSilenceBridge, stopSilenceBridge, fetchReactions, attachStatusListener, teardownPlayer]);

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

    if (offlineModeRef.current) {
      playNextOfflineRef.current?.();
      return;
    }

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
    console.log('[AppState] Wake — radioState:', radioStateRef.current, 'localPaused:', localPausedRef.current);

    if (localPausedRef.current) return;            // user paused / tuned out
    if (radioStateRef.current === 'idle') return;

    if (offlineModeRef.current) {
      // Clear any bridge handleBackgroundAndroid may have pre-started — a
      // lingering isBridgingRef freezes the progress UI (startProgressTimer
      // skips ticks while bridging) until the next track calls stopSilenceBridge().
      stopSilenceBridge();
      if (playerRef.current?.playing) return;
      try { playerRef.current?.play(); } catch {}
      await new Promise<void>((r) => setTimeout(r, 1_000));
      if (!playerRef.current?.playing && !localPausedRef.current) playNextOfflineRef.current?.();
      return;
    }

    if (playerRef.current?.playing) return;        // already audible

    if (radioStateRef.current === 'playing' && playerRef.current && playerReadyRef.current) {
      // Try a simple resume first (covers normal backgrounding)
      try { playerRef.current.play(); } catch {}
      await new Promise<void>((r) => setTimeout(r, 1_000));
      if (playerRef.current?.playing) return;      // cheap resume worked
      console.log('[Wake] Player did not resume — re-syncing');
    }

    if (isFetchingRef.current) {
      // A fetch is (or claims to be) in flight — give it a short grace window,
      // then assume it's a zombie suspended by iOS and invalidate its epoch.
      await new Promise<void>((r) => setTimeout(r, 4_000));
      if (playerRef.current?.playing) return;
      if (isFetchingRef.current) {
        console.log('[Wake] Fetch still in-flight after grace — invalidating epoch + retrying');
        fetchEpochRef.current++;
        isFetchingRef.current = false;
      }
    }

    // Immediate guarded re-sync — kills the 10s first-poll delay. Idempotency
    // lives inside fetchAndPlay (same-track no-op / retry, no-track → poll).
    stopPolling();
    await fetchAndPlay();
  }, [fetchAndPlay, stopPolling, stopSilenceBridge]);

  // ------------------------------------------------------------------ //
  // WebSocket
  // ------------------------------------------------------------------ //

  const connectWebSocket = useCallback(() => {
    if (offlineModeRef.current) return;
    if (!isActiveRef.current) return;
    // Never log the URL itself — it carries the token.
    const url = wsUrl(tokenRef.current);
    console.log('[WS] Connecting', tokenRef.current ? '(authenticated)' : '(anonymous)');

    const ws = new WebSocket(url);
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
      // Reconnect re-sync: if we should be playing but aren't (e.g. missed a
      // play_now while the socket was down), do one guarded fetch.
      if (
        !localPausedRef.current &&
        !isFetchingRef.current &&
        !(playerRef.current?.playing ?? false) &&
        !isBridgingRef.current &&
        radioStateRef.current !== 'polling' &&
        radioStateRef.current !== 'idle'
      ) {
        console.log('[WS] reconnected while not audible — re-syncing');
        fetchAndPlayRef.current?.();
      }
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
        const { for_track_id } = msg.data as { for_track_id?: string };
        console.log('[WS] play_now received for', for_track_id, '— current:', currentTrackIdRef.current);
        // Stuck-mutex escape: a fetch started long ago is a zombie (suspended by
        // iOS mid-await) — invalidate it so the watchdog can recover playback.
        if (isFetchingRef.current && Date.now() - fetchStartedAtRef.current > FETCH_STUCK_MS) {
          console.log('[WS] play_now — fetch mutex stuck, invalidating epoch');
          fetchEpochRef.current++;
          isFetchingRef.current = false;
        }
        if (
          !localPausedRef.current &&
          !isFetchingRef.current &&
          (currentTrackIdRef.current === null || !for_track_id || currentTrackIdRef.current === for_track_id)
        ) {
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
      } else if (msg.event === 'role_assigned') {
        // The server's verdict on this connection's identity. djAvailable is
        // true iff the token was accepted on the upgrade, so it — not the mere
        // presence of a local token — is what the DJ button is gated on.
        const d = msg.data as unknown as RoleAssignedData;
        console.log('[WS] role_assigned — role:', d.role, 'djAvailable:', d.djAvailable);
        setDjAvailable(d.djAvailable);
        setDjNickname(d.nickname ?? '');
        // Identity was just re-evaluated; any earlier refusal is now stale.
        setDjClaimRefusal(null);
      } else if (msg.event === 'dj_state') {
        const d = msg.data as unknown as DjStateData;
        setDjLocked(d.locked);
        setDjUnlockAt(d.unlockAt);
        setActiveDjName(d.activeDjName);
      } else if (msg.event === 'dj_claim_ack') {
        const { granted, reason } = msg.data as unknown as DjClaimAckData;
        console.log('[DJ] Claim ack — granted:', granted, reason ? `(${reason})` : '');
        if (granted) {
          setDjPanelOpen(true);
          setDjClaimRefusal(null);
        } else if (reason === 'auth_required' || reason === 'session_expired') {
          // 'locked' needs no message — the countdown on screen already says so.
          setDjClaimRefusal(reason);
        }
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
    // A staging directory here means a download was killed mid-flight. It is
    // never useful, and on Android it holds the truncated mp3 files.
    cleanupStagingDir();

    // Resume offline mode across a restart. A cold start in airplane mode used
    // to come up as the online radio and sit in a reconnect loop — the app
    // worked on a plane only for as long as you never closed it.
    if (isOfflineModePersisted()) {
      const tracks = scanOfflineTracks();
      if (tracks.length > 0) {
        console.log('[Offline] resuming offline mode from last run —', tracks.length, 'tracks');
        // Hand off to the audio-ready path; deliberately skip connectWebSocket
        // and the first fetch so no online traffic happens at all.
        pendingOfflineResumeRef.current = tracks;
        return () => { isActiveRef.current = false; };
      }
      // The library went away (uninstalled data, manual clear) — do not strand
      // the app in an offline mode with nothing to play.
      console.log('[Offline] persisted offline mode had no tracks — starting online');
      setOfflineModePersisted(false);
    }

    connectWebSocket();
    // Mark play-intent before the first fetch (mirrors tuneIn). localPaused
    // initializes true, and without this handleWake and play_now bail at their
    // paused guards during the whole pre-first-track window — backgrounding
    // before the first song would leave the app silent forever.
    localPausedRef.current = false;
    setLocalPaused(false);
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

  // Identity changed (sign-in or sign-out): drop the socket and open a new one
  // so the server re-reads the token on the upgrade. Without this the DJ button
  // would not appear until the app was restarted.
  const lastAuthVersion = useRef(authVersion);
  useEffect(() => {
    if (lastAuthVersion.current === authVersion) return;   // includes the mount pass
    lastAuthVersion.current = authVersion;
    // The server's old verdict describes an identity we no longer have, so it
    // is stale in every mode — clear it before deciding whether to reconnect.
    setDjAvailable(false);
    setDjNickname('');
    setDjClaimRefusal(null);
    // Offline mode deliberately holds no socket. Signing out mid-playback must
    // not reconnect — or interrupt the track. exitOfflineMode connects later
    // with whatever identity is current by then.
    //
    // The pending check covers the window during an offline resume: hydrating
    // the session from SecureStore bumps authVersion within milliseconds of
    // mount, before enterOfflineMode has run, so without it a resume would open
    // the very socket it is trying not to open.
    if (offlineModeRef.current || pendingOfflineResumeRef.current || !isActiveRef.current) return;
    if (wsRef.current) {
      const dyingWs = wsRef.current;
      wsRef.current = null;
      dyingWs.onclose = null;        // this close is intentional — do not back off
      dyingWs.close();
    }
    if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
    if (reconnectTimer.current)  { clearTimeout(reconnectTimer.current);   reconnectTimer.current  = null; }
    reconnectDelay.current = RECONNECT_BASE_MS;
    connectWebSocket();
  }, [authVersion, connectWebSocket]);

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
        if (bgWatchdogRef.current) {
          clearTimeout(bgWatchdogRef.current);
          bgWatchdogRef.current = null;
        }
        // Cancel the background first-track wait cap; the foreground
        // handleWake/fetch path takes over recovery from here.
        if (bgWaitCapTimerRef.current) {
          clearTimeout(bgWaitCapTimerRef.current);
          bgWaitCapTimerRef.current = null;
        }
        // Cancel any in-flight native status fetch listener (Android).
        bgStatusCleanupRef.current?.();
        bgStatusCleanupRef.current = null;
        // iOS: re-attach playbackStatusUpdate listener removed on background entry.
        // Android: listener was never removed, so this is a no-op there.
        if (Platform.OS === 'ios') handleForegroundIOS(wasBackground);
        // Reconnect WS (closed in 'inactive' on iOS, 'background' on Android).
        if (wsRef.current === null && !offlineModeRef.current) connectWebSocket();
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
        // iOS first-track wait: if the silence bridge is holding an active
        // audio session and no track has ever played, keep polling alive —
        // the session keeps the app unsuspended, so JS timers + fetch still
        // work (same mechanism the mid-session iOS path relies on). Bounded
        // by a cap timer (App Review 2.5.4 disallows indefinite silent
        // background audio). Android keeps its native-module fallbacks.
        if (
          Platform.OS === 'ios' &&
          currentTrackIdRef.current === null &&
          isBridgingRef.current &&
          !localPausedRef.current
        ) {
          console.log('[BG] iOS — waiting for first track: keeping poll + bridge alive');
          if (bgWaitCapTimerRef.current) clearTimeout(bgWaitCapTimerRef.current);
          bgWaitCapTimerRef.current = setTimeout(() => {
            bgWaitCapTimerRef.current = null;
            if (isBackgroundRef.current && currentTrackIdRef.current === null) {
              console.log('[BG] first-track wait cap reached — releasing poll + bridge');
              stopPolling();
              stopSilenceBridge();
            }
          }, BG_FIRST_TRACK_WAIT_CAP_MS);
        } else {
          stopPolling();
        }
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
  }, [handleWake, stopPolling, stopSilenceBridge, connectWebSocket, startProgressTimer, stopProgressTimer, handleBackgroundIOS, handleBackgroundAndroid, handleForegroundIOS]);

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
    if (bgWatchdogRef.current) { clearTimeout(bgWatchdogRef.current); bgWatchdogRef.current = null; }
    stopSilenceBridge();
    if (playerReadyRef.current) teardownPlayer();
  }, [stopPolling, stopSilenceBridge, teardownPlayer]);

  const enterOfflineMode = useCallback((tracks: OfflineTrackMeta[]) => {
    if (tracks.length === 0) return;
    // Bail before mutating anything: entering offline mode while the audio
    // session is still initialising used to leave the banner up with the online
    // track audible, because playOfflineTrack returned early.
    if (!playerReadyRef.current) return;
    // Re-entering would rebuild the queue mid-playback and restart the track.
    // exitOfflineMode has always had this guard; its counterpart did not.
    if (offlineModeRef.current) return;
    setOfflineMode(true);
    setOfflineModePersisted(true);
    // ---- suppress ALL server activity ----
    stopPolling();                                        // pollTimerRef
    fetchEpochRef.current++;                              // invalidate any in-flight fetchAndPlay
    isFetchingRef.current = false;
    if (wsRef.current) {                                  // close WS exactly like the 'inactive' handler
      const dyingWs = wsRef.current; wsRef.current = null;
      dyingWs.onclose = null; dyingWs.close();
    }
    if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
    if (reconnectTimer.current)  { clearTimeout(reconnectTimer.current);   reconnectTimer.current  = null; }
    if (bgTrackEndTimerRef.current) { clearTimeout(bgTrackEndTimerRef.current); bgTrackEndTimerRef.current = null; }
    if (bgWaitCapTimerRef.current)  { clearTimeout(bgWaitCapTimerRef.current);  bgWaitCapTimerRef.current  = null; }
    bgStatusCleanupRef.current?.(); bgStatusCleanupRef.current = null;    // Android native fetch listener
    // A native background download of the *online* track can outlive the switch
    // and land in documents/track_current.mp3 long after we stopped caring,
    // burning cellular data the user went offline to avoid.
    cancelCurrentDownload();
    stopSilenceBridge();
    // ---- reset online-only UI state ----
    setListenerCount(0); setViewers([]); setActivityLog([]);
    setReactionState(emptyReaction); reactionStateRef.current = emptyReaction;
    setErrorMessage(null);
    // ---- build queue & play ----
    offlineTracksRef.current = new Map(tracks.map((t) => [t.trackId, t]));
    setOfflineTrackCount(tracks.length);
    offlineQueueRef.current = [];
    offlineQueuePosRef.current = -1;      // playNextOffline will shuffle on first call
    currentTrackIdRef.current = null;
    localPausedRef.current = false; setLocalPaused(false);
    playNextOffline();
  }, [stopPolling, stopSilenceBridge, playNextOffline]);

  // Published for the mount-time offline resume, which runs before this
  // callback exists in scope.
  useEffect(() => {
    enterOfflineModeRef.current = enterOfflineMode;
  }, [enterOfflineMode]);

  const exitOfflineMode = useCallback(async () => {
    if (!offlineModeRef.current) return;
    // Confirm the server is actually reachable BEFORE tearing down offline
    // state. Pressing this in airplane mode used to wipe the queue, stop the
    // player and drop into a reconnect loop with nothing playing — the one
    // situation where offline mode was most wanted.
    try {
      const res = await fetch(`${BACKEND_URL}/api/radio/status`, {
        signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      console.log('[Offline] exit refused — server unreachable:', err);
      setErrorMessage('Still offline — no connection to the radio');
      return;                                   // queue, player and files untouched
    }
    setOfflineMode(false);
    setOfflineModePersisted(false);
    if (bgTrackEndTimerRef.current) { clearTimeout(bgTrackEndTimerRef.current); bgTrackEndTimerRef.current = null; }
    if (bgWatchdogRef.current) { clearTimeout(bgWatchdogRef.current); bgWatchdogRef.current = null; }
    playerSubRef.current?.remove(); playerSubRef.current = null;
    teardownPlayer();                                    // same teardown as tuneOut
    offlineTracksRef.current = new Map();
    offlineQueueRef.current = [];
    offlineQueuePosRef.current = -1;
    setOfflineTrackCount(0);
    currentTrackIdRef.current = null;
    setCurrentTrack(null); setProgress(0); setAudioDuration(null);
    setStatusMessage(''); setErrorMessage(null);
    isFetchingRef.current = false;
    fetchEpochRef.current++;
    localPausedRef.current = false; setLocalPaused(false);
    setRadioState('fetching');
    connectWebSocket();                                   // wsRef is null → connects
    fetchAndPlayRef.current?.();                          // resume server-driven radio
  }, [connectWebSocket, teardownPlayer]);

  const saveTrack = useCallback(async (trackId: string): Promise<void> => {
    const res = await fetch(`${BACKEND_URL}/api/tracks/${trackId}/save`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error((err as { detail?: string }).detail ?? 'Save failed');
    }
  }, []);

  const claimDj = useCallback(() => sendWS({ event: 'dj_claim' }), [sendWS]);

  const clearDjClaimRefusal = useCallback(() => setDjClaimRefusal(null), []);

  const submitDj = useCallback((
    genres: string[], keywords: string[],
    language: string, feeling: string,
  ) => {
    setDjPanelOpen(false);
    // No djName: the server attributes the session to the authenticated user.
    sendWS({ event: 'dj_submit', data: { genres, keywords, language, feeling } });
  }, [sendWS]);

  const closeDjPanel = useCallback(() => {
    setDjPanelOpen(false);
    sendWS({ event: 'dj_cancel' });
  }, [sendWS]);

  const react = useCallback(async (trackId: string, action: 'thumb_up' | 'thumb_down'): Promise<void> => {
    if (offlineModeRef.current) return;
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
      // Use localPausedRef (JS intent) rather than p.playing (native state) to decide
      // the action. The media widget can change native state without updating JS refs,
      // so p.playing may be stale and would cause the wrong action to fire.
      if (localPausedRef.current) {
        p.play();
        setLocalPaused(false);
        localPausedRef.current = false;
        setRadioState('playing');
      } else {
        p.pause();
        setLocalPaused(true);
        localPausedRef.current = true;
        setRadioState('paused');
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
    djAvailable, djNickname, djClaimRefusal, clearDjClaimRefusal,
    claimDj, submitDj, closeDjPanel,
    reactionState, react,
    offlineMode, offlineTrackCount, enterOfflineMode, exitOfflineMode,
  };
}
