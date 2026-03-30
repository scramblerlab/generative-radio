import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import TrackPlayer, {
  Event,
  State,
  useTrackPlayerEvents,
  Capability,
  IOSCategory,
  IOSCategoryOptions,
  AppKilledPlaybackBehavior,
} from 'react-native-track-player';
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

  // ------------------------------------------------------------------ //
  // TrackPlayer setup
  // ------------------------------------------------------------------ //
  useEffect(() => {
    let mounted = true;
    TrackPlayer.setupPlayer({
      maxCacheSize: 1024 * 5,
      iosCategory: IOSCategory.Playback,
      iosCategoryOptions: [IOSCategoryOptions.DuckOthers],
      autoHandleInterruptions: true,
    }).then(() => {
      if (!mounted) return;
      TrackPlayer.updateOptions({
        capabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SeekTo,
          Capability.JumpForward,
          Capability.JumpBackward,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause],
        forwardJumpInterval: 10,
        backwardJumpInterval: 10,
        android: {
          appKilledPlaybackBehavior: AppKilledPlaybackBehavior.PausePlayback,
        },
      });
      playerReadyRef.current = true;
      console.log('[RNTP] Player ready');
    }).catch((err: Error) => {
      if (err.message?.includes('already')) {
        playerReadyRef.current = true;
      } else {
        console.error('[RNTP] setupPlayer failed:', err);
      }
    });
    return () => { mounted = false; };
  }, []);

  // ------------------------------------------------------------------ //
  // RNTP progress polling
  // ------------------------------------------------------------------ //
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!playerReadyRef.current) return;
      try {
        const pos = await TrackPlayer.getPosition();
        const dur = await TrackPlayer.getDuration();
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
  // Polling
  // ------------------------------------------------------------------ //

  // Use a ref to hold the latest fetchAndPlay to break the circular dep
  // between startPolling and fetchAndPlay.
  const fetchAndPlayRef = useRef<(() => Promise<void>) | undefined>(undefined);

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
        console.log('[Radio] Already playing track', track.id, '— rechecking RNTP state');
        const { state } = await TrackPlayer.getPlaybackState();
        const rntpPlaying = state === State.Playing || state === State.Buffering || state === State.Loading;
        isFetchingRef.current = false;
        if (rntpPlaying) {
          setRadioState('playing');
        } else {
          // Server is still on same track but RNTP stopped — wait for server to advance
          // Retry after the debounce window
          console.log('[Radio] Same track, RNTP stopped — retrying after', DEBOUNCE_RETRY_MS, 'ms');
          setTimeout(() => fetchAndPlayRef.current?.(), DEBOUNCE_RETRY_MS);
        }
        return;
      }

      stopPolling();

      // Signal previous track ended — do this BEFORE resetting RNTP so the
      // server has maximum time to generate the next track while we play.
      const hadPreviousTrack = currentTrackIdRef.current !== null;
      if (hadPreviousTrack) {
        await sendTrackEnded();
      }

      // Download audio to fixed local file
      const localUri = await downloadAudio(track);

      // Set up RNTP
      if (!playerReadyRef.current) throw new Error('Player not ready');
      await TrackPlayer.reset();
      await TrackPlayer.add({
        id: track.id,
        url: localUri,
        title: track.songTitle,
        artist: track.genre,
        album: 'Generative Radio',
        duration: track.duration,
      });

      localPausedRef.current = false;
      setLocalPaused(false);
      await TrackPlayer.play();

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
  }, [sendTrackEnded, startPolling, stopPolling, fetchReactions]);

  // Keep the ref in sync so polling and other callbacks can always call the latest version
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
    // Signal the server immediately so it starts generating the next track.
    // fetchAndPlay may also send it when it sees a new track, but the server
    // debounces duplicates — sending here is what unblocks single-client flows.
    await sendTrackEnded();
    await fetchAndPlay();
  }, [fetchAndPlay, sendTrackEnded]);

  // ------------------------------------------------------------------ //
  // Wake from background
  // ------------------------------------------------------------------ //

  const handleWake = useCallback(async () => {
    const state = radioStateRef.current;
    console.log('[AppState] Wake — radioState:', state, 'localPaused:', localPausedRef.current);

    if (localPausedRef.current) return;

    switch (state) {
      case 'playing': {
        const { state: rntpState } = await TrackPlayer.getPlaybackState();
        const active = rntpState === State.Playing || rntpState === State.Buffering;
        if (!active && playerReadyRef.current) {
          // Try a simple resume first (covers normal backgrounding)
          try { await TrackPlayer.play(); } catch {}
          await new Promise<void>((r) => setTimeout(r, 1_000));
          const { state: after } = await TrackPlayer.getPlaybackState();
          if (after !== State.Playing && after !== State.Buffering) {
            console.log('[Wake] RNTP did not resume — re-fetching');
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
  // RNTP events
  // ------------------------------------------------------------------ //

  useTrackPlayerEvents([Event.PlaybackQueueEnded], () => {
    console.log('[RNTP] Queue ended');
    handleTrackEnded();
  });

  useTrackPlayerEvents([Event.PlaybackState], (event) => {
    console.log('[RNTP] State →', event.state);
  });

  useTrackPlayerEvents([Event.PlaybackError], async (event) => {
    console.error('[RNTP] Playback error — code:', event.code, 'message:', event.message);
    if (localPausedRef.current) return;
    await new Promise<void>((r) => setTimeout(r, 1_000));
    const { state } = await TrackPlayer.getPlaybackState();
    const recovered = state === State.Playing || state === State.Buffering || state === State.Loading;
    if (!recovered) {
      console.log('[RNTP] Error not self-recovered — calling fetchAndPlay');
      isFetchingRef.current = false;
      await fetchAndPlay();
    }
  });

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
        // Re-fetch to recover without using the payload (payload has for_track_id, not a full Track).
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

  // tuneIn: re-trigger fetch (e.g. after error or manual stop)
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
    if (playerReadyRef.current) {
      try { await TrackPlayer.pause(); await TrackPlayer.reset(); } catch {}
    }
  }, [stopPolling]);

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
      setReactionState((prev) => ({ ...prev, userReaction: data.userReaction as ReactionState['userReaction'] }));
    } catch (err) {
      console.error('[Reactions] React failed:', err);
    }
  }, []);

  const togglePlayPause = useCallback(async () => {
    if (!playerReadyRef.current) return;
    try {
      const { state } = await TrackPlayer.getPlaybackState();
      if (state === State.Playing) {
        await TrackPlayer.pause();
        setLocalPaused(true);
        localPausedRef.current = true;
        setRadioState('paused');
      } else {
        await TrackPlayer.play();
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
    try {
      const pos = await TrackPlayer.getPosition();
      await TrackPlayer.seekTo(Math.max(0, pos - 10));
    } catch {}
  }, []);

  const seekForward = useCallback(async () => {
    if (!playerReadyRef.current) return;
    try {
      const [pos, dur] = await Promise.all([TrackPlayer.getPosition(), TrackPlayer.getDuration()]);
      await TrackPlayer.seekTo(Math.min(dur, pos + 10));
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
