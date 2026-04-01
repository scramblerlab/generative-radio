import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
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
  const isFetchingRef = useRef(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActiveRef = useRef(false);
  const playerReadyRef = useRef(false);

  // expo-audio player refs
  const playerRef = useRef<AudioPlayer | null>(null);        // active music player
  const silencePlayerRef = useRef<AudioPlayer | null>(null); // silence bridge
  const isBridgingRef = useRef(false);                       // silence bridge active?

  // ------------------------------------------------------------------ //
  // expo-audio setup
  // ------------------------------------------------------------------ //
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
      allowsRecording: false,
    }).then(() => {
      playerReadyRef.current = true;
      console.log('[Audio] AudioMode configured');
    }).catch((err: Error) => {
      console.error('[Audio] setAudioModeAsync failed:', err);
    });
  }, []);

  // ------------------------------------------------------------------ //
  // Progress polling
  // ------------------------------------------------------------------ //
  useEffect(() => {
    const interval = setInterval(() => {
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
    return () => clearInterval(interval);
  }, []);

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
    // HTTP fallback when WS is dead after sleep
    console.log('[Radio] WS not open — track_ended via HTTP fallback');
    try {
      await fetch(`${BACKEND_URL}/api/radio/track-ended`, { method: 'POST' });
    } catch (err) {
      console.warn('[Radio] HTTP track-ended fallback failed:', err);
      // Best-effort; server watchdog fires after duration+3s
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
      const s = createAudioPlayer(require('../../assets/silence.mp3'));
      s.loop = true;
      s.play();
      silencePlayerRef.current = s;
      console.log('[Radio] Silence bridge started');
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
  // Polling
  // ------------------------------------------------------------------ //

  // Use a ref to hold the latest fetchAndPlay to break the circular dep
  // between startPolling and fetchAndPlay.
  const fetchAndPlayRef = useRef<(() => Promise<void>) | undefined>(undefined);

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

  const fetchAndPlay = useCallback(async () => {
    if (isFetchingRef.current) {
      console.log('[Radio] fetchAndPlay: mutex held, skipping');
      return;
    }
    isFetchingRef.current = true;
    setRadioState('fetching');
    setStatusMessage('Loading track...');
    setErrorMessage(null);

    try {
      const res = await fetch(`${BACKEND_URL}/api/radio/status`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json() as { currentTrack: Track | null };

      if (!data.currentTrack) {
        // No track yet — server still generating; poll
        console.log('[Radio] No track on server yet — starting poll');
        isFetchingRef.current = false;
        startPolling();
        return;
      }

      const track = data.currentTrack;

      // Duplicate guard: already playing this track
      if (currentTrackIdRef.current === track.id) {
        console.log('[Radio] Already playing track', track.id, '— rechecking player state');
        const isPlaying = (playerRef.current?.playing ?? false) || isBridgingRef.current;
        isFetchingRef.current = false;
        if (isPlaying) {
          setRadioState('playing');
        } else {
          // Server is still on same track but player stopped — wait for server to advance
          console.log('[Radio] Same track, player stopped — retrying after', DEBOUNCE_RETRY_MS, 'ms');
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
      const localUri = await downloadAudio(track);

      // Stop silence bridge and set up new AudioPlayer
      if (!playerReadyRef.current) throw new Error('Player not ready');
      stopSilenceBridge();

      // Tear down old player before creating new one
      playerRef.current?.remove();
      playerRef.current = null;

      const player = createAudioPlayer({ uri: localUri });

      // Detect track end via didJustFinish in status updates
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish && !localPausedRef.current) {
          handleTrackEndedRef.current?.();
        }
      });

      // Register for lock screen controls (also required on Android for
      // sustained background playback beyond ~3 min)
      player.setActiveForLockScreen(true, {
        title: track.songTitle,
        artist: track.genre,
        albumTitle: 'Generative Radio',
      }, { showSeekForward: true, showSeekBackward: true });

      playerRef.current = player;
      localPausedRef.current = false;
      setLocalPaused(false);
      player.play();

      currentTrackIdRef.current = track.id;
      setCurrentTrack(track);
      setRadioState('playing');
      setStatusMessage('');
      setProgress(0);
      setAudioDuration(null);
      fetchReactions(track.id);

    } catch (err) {
      console.error('[Radio] fetchAndPlay failed:', err);
      setRadioState('error');
      setErrorMessage('Failed to load track — retrying...');
      isFetchingRef.current = false;
      setTimeout(() => fetchAndPlayRef.current?.(), 3_000);
      return;
    }

    isFetchingRef.current = false;
  }, [sendTrackEnded, startPolling, stopPolling, stopSilenceBridge, fetchReactions]);

  // Keep the refs in sync so polling and other callbacks always call the latest version
  useEffect(() => {
    fetchAndPlayRef.current = fetchAndPlay;
  }, [fetchAndPlay]);

  // ------------------------------------------------------------------ //
  // Track ended
  // ------------------------------------------------------------------ //

  const handleTrackEnded = useCallback(async () => {
    console.log('[Radio] handleTrackEnded — current:', currentTrackIdRef.current);
    if (localPausedRef.current) return;
    if (isFetchingRef.current) return;
    // Start silence bridge immediately to keep iOS audio session alive during download
    startSilenceBridge();
    // Signal the server immediately so it starts generating the next track.
    await sendTrackEnded();
    await fetchAndPlay();
  }, [fetchAndPlay, sendTrackEnded, startSilenceBridge]);

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
      let msg: WSMessage;
      try {
        msg = JSON.parse(event.data as string) as WSMessage;
      } catch {
        console.error('[WS] Failed to parse message:', event.data);
        return;
      }
      console.log('[WS] Received:', msg.event);

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
      if (isActiveRef.current && wsRef.current === ws) {
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
      console.log('[AppState]', nextState);
      if (nextState === 'active') {
        handleWake();
      } else if (nextState === 'background') {
        // Suspend poll timer — iOS may kill it anyway; handleWake restarts it
        stopPolling();
      }
    });
    return () => sub.remove();
  }, [handleWake, stopPolling]);

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
