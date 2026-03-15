import { useState, useEffect, useRef, useCallback, RefObject } from 'react';
import {
  Track,
  RadioStatus,
  ClientRole,
  WSMessage,
  TrackReadyData,
  StatusData,
  ErrorData,
  ActivityEntry,
  ProgressData,
  ListenerCountData,
  RoleAssignedData,
  ViewerInfo,
  ViewerListData,
  AdvancedOptions,
  DjStateData,
  DjClaimAckData,
} from '../types';

export interface UseRadioReturn {
  role: ClientRole | null;
  status: RadioStatus;
  currentTrack: Track | null;
  nextReady: boolean;
  statusMessage: string;
  errorMessage: string | null;
  activityLog: ActivityEntry[];
  listenerCount: number;
  audioBlocked: boolean;
  viewers: ViewerInfo[];
  audioDuration: number | null; // Actual decoded audio duration (seconds); null until loaded
  saveTrack: (trackId: string) => Promise<void>;
  start: (genres: string[], keywords: string[], language: string, feeling?: string, advancedOptions?: AdvancedOptions) => Promise<void>;
  stop: () => Promise<void>;
  updateSettings: (genres: string[], keywords: string[], language: string, feeling?: string, advancedOptions?: AdvancedOptions) => void;
  unblockAudio: () => void;
  audioRef: RefObject<HTMLAudioElement | null>;
  progress: number; // 0–1
  localPaused: boolean; // True when user has locally paused playback (audio.pause())
  togglePlayPause: () => void;
  seekBackward: () => void; // Seek -10s
  seekForward: () => void;  // Seek +10s
  // DJ mode
  djLocked: boolean;
  djUnlockAt: number;       // Unix timestamp (seconds) when DJ button becomes available
  activeDjName: string;     // Name of the current DJ (empty if none)
  djPanelOpen: boolean;     // Whether the DJ panel modal is open for this client
  claimDj: () => void;
  submitDj: (genres: string[], keywords: string[], language: string, feeling: string, djName: string) => void;
  closeDjPanel: () => void;
}

const WS_URL = '/ws';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 16_000;

export function useRadio(): UseRadioReturn {
  const [role, setRole] = useState<ClientRole | null>(null);
  const [status, setStatus] = useState<RadioStatus>('idle');
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [nextReady, setNextReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [listenerCount, setListenerCount] = useState(0);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [viewers, setViewers] = useState<ViewerInfo[]>([]);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [localPaused, setLocalPaused] = useState(false);
  const activityIdRef = useRef(0);

  // DJ mode state
  const [djLocked, setDjLocked] = useState(true);
  const [djUnlockAt, setDjUnlockAt] = useState(0);
  const [activeDjName, setActiveDjName] = useState('');
  const [djPanelOpen, setDjPanelOpen] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nextTrackRef = useRef<Track | null>(null);        // Pre-buffered next track metadata
  const preloadBlobUrlRef = useRef<string | null>(null);  // In-memory blob URL for the next track
  const activeBlobUrlRef = useRef<string | null>(null);   // Blob URL currently being played (revoke on next transition)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const isActiveRef = useRef(false);                      // True while radio should maintain WS

  // ------------------------------------------------------------------ //
  // Blob URL lifecycle helpers
  // ------------------------------------------------------------------ //

  /** Revoke and clear any existing pre-fetched blob URL. */
  const clearPreloadBlob = useCallback(() => {
    if (preloadBlobUrlRef.current) {
      URL.revokeObjectURL(preloadBlobUrlRef.current);
      preloadBlobUrlRef.current = null;
      console.log('[Audio] Pre-fetch blob URL revoked (superseded or session ended)');
    }
  }, []);

  /** Revoke and clear the blob URL for the track that just finished playing. */
  const clearActiveBlob = useCallback(() => {
    if (activeBlobUrlRef.current) {
      URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = null;
    }
  }, []);

  // ------------------------------------------------------------------ //
  // Audio progress tracking
  // ------------------------------------------------------------------ //

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      if (audio.duration > 0) {
        setProgress(audio.currentTime / audio.duration);
      }
    };
    const onLoadedMetadata = () => {
      if (audio.duration > 0) {
        setAudioDuration(Math.round(audio.duration));
      }
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  // audioRef is a stable object; the effect only needs to run once at mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ //
  // Internal helpers
  // ------------------------------------------------------------------ //

  const sendWS = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(data);
      console.log('[WS] Sending:', data);
      wsRef.current.send(payload);
    } else {
      console.warn('[WS] Cannot send — socket not open:', wsRef.current?.readyState);
    }
  }, []);

  const playTrack = useCallback((track: Track) => {
    console.log('[Audio] Playing track:', track.songTitle);
    setCurrentTrack(track);
    setProgress(0);

    setLocalPaused(false);

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.songTitle,
        artist: track.genre,
        album: 'Generative Radio',
        artwork: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
      navigator.mediaSession.playbackState = 'playing';
    }
    setAudioDuration(null);
    setErrorMessage(null);

    // Revoke the previously active blob URL — the old track is no longer needed.
    clearActiveBlob();

    const audio = audioRef.current;
    if (audio) {
      const blobUrl = preloadBlobUrlRef.current;

      if (blobUrl) {
        // Pre-fetch completed — play from the in-memory blob URL instantly.
        console.log('[Audio] ✓ Using pre-fetched blob URL — zero network wait for:', track.songTitle);
        audio.src = blobUrl;
        activeBlobUrlRef.current = blobUrl;  // Track for later revocation
        preloadBlobUrlRef.current = null;
      } else {
        // No pre-fetch available — fall back to direct backend URL.
        // This happens for the first track and on buffering-recovery paths.
        console.warn('[Audio] ✗ No pre-fetched blob — fetching directly from backend:', track.songTitle);
        audio.src = track.audioUrl;
        activeBlobUrlRef.current = null;
      }

      audio.play()
        .then(() => setAudioBlocked(false))
        .catch((err) => {
          console.error('[Audio] play() failed:', err);
          // Browsers block autoplay when there has been no prior user gesture.
          // Surface a "Tap to Listen" button so the viewer can unlock audio manually.
          if (err instanceof DOMException && err.name === 'NotAllowedError') {
            console.log('[Audio] Autoplay blocked — user gesture required');
            setAudioBlocked(true);
          }
        });
    }
  }, [clearActiveBlob]);

  /**
   * Pre-fetch the next track's audio bytes and store as a blob URL.
   * Called as soon as the server signals that the next track is ready.
   * The download runs entirely in the background while the current track plays.
   */
  const prefetchNextTrack = useCallback((track: Track) => {
    clearPreloadBlob(); // Clear any stale pre-fetch from a previous cycle
    const t0 = performance.now();
    console.log('[Audio] Pre-fetch starting for:', track.songTitle, '—', track.audioUrl);

    fetch(track.audioUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        preloadBlobUrlRef.current = URL.createObjectURL(blob);
        console.log(
          `[Audio] Pre-fetch complete for "${track.songTitle}" in ${elapsed}s` +
          ` — ${(blob.size / 1024).toFixed(0)} KB buffered in memory`
        );
      })
      .catch((err) => {
        console.error('[Audio] Pre-fetch failed for', track.songTitle, ':', err);
      });
  }, [clearPreloadBlob]);

  const handleTrackEnded = useCallback(() => {
    const blobReady = preloadBlobUrlRef.current !== null;
    console.log(
      '[Audio] Track ended —',
      nextTrackRef.current ? `next track: "${nextTrackRef.current.songTitle}"` : 'no next track cached',
      `| blob pre-fetched: ${blobReady}`
    );
    setProgress(0);

    // Notify the backend regardless of which path we take
    sendWS({ event: 'track_ended' });

    if (nextTrackRef.current) {
      // Happy path: next track metadata is ready (blob may or may not be ready)
      const next = nextTrackRef.current;
      nextTrackRef.current = null;
      setNextReady(false);
      setStatus('playing');
      playTrack(next);
    } else {
      // Buffering path: waiting for server to send the next track
      console.log('[Radio] No next track cached — entering buffering state');
      setStatus('buffering');
      setStatusMessage('Buffering next track...');
    }
  }, [sendWS, playTrack]);

  // ------------------------------------------------------------------ //
  // WebSocket connection
  // ------------------------------------------------------------------ //

  const connectWebSocket = useCallback(() => {
    if (!isActiveRef.current) return;

    console.log('[WS] Connecting to', WS_URL, '...');
    setStatus('connecting');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connection established');
      reconnectDelay.current = RECONNECT_BASE_MS;
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: WSMessage;
      try {
        msg = JSON.parse(event.data as string) as WSMessage;
      } catch {
        console.error('[WS] Failed to parse message:', event.data);
        return;
      }

      console.log('[WS] Received event:', msg.event, msg.data);

      if (msg.event === 'role_assigned') {
        const { role: assignedRole } = msg.data as unknown as RoleAssignedData;
        console.log('[Radio] Role assigned:', assignedRole);
        setRole(assignedRole);
      } else if (msg.event === 'track_ready') {
        const { track, isNext } = msg.data as unknown as TrackReadyData;

        if (!isNext) {
          // Server says: play this track now (first track or buffering-recovery path).
          // Clear nextTrackRef — the buffering path sends isNext=true then isNext=false
          // for the same track; without this clear, handleTrackEnded would replay it.
          console.log('[Radio] track_ready (current) — playing:', track.songTitle);
          nextTrackRef.current = null;
          setNextReady(false);
          setStatus('playing');
          playTrack(track);
        } else {
          // Server says: this is the next track — start pre-fetching its audio bytes
          // immediately so they're ready in memory before the current track ends.
          console.log('[Radio] track_ready (next, pre-buffering) —', track.songTitle);
          nextTrackRef.current = track;
          setNextReady(true);
          prefetchNextTrack(track);
        }
      } else if (msg.event === 'status') {
        const { state, message, nextReady: nr } = msg.data as unknown as StatusData;
        console.log('[Radio] Status update:', state, '—', message);
        setStatus(state);
        setStatusMessage(message);
        setNextReady(nr);
      } else if (msg.event === 'progress') {
        const { stage, message } = msg.data as unknown as ProgressData;
        console.log(`[Radio] Progress [${stage}]: ${message}`);
        setActivityLog((prev) => [
          ...prev,
          { id: activityIdRef.current++, stage, message },
        ]);
      } else if (msg.event === 'listener_count') {
        const { count } = msg.data as unknown as ListenerCountData;
        console.log('[Radio] Listener count:', count);
        setListenerCount(count);
      } else if (msg.event === 'viewer_list') {
        const { viewers: vl } = msg.data as unknown as ViewerListData;
        console.log('[Radio] Viewer list updated:', vl.length, 'viewer(s)');
        setViewers(vl);
      } else if (msg.event === 'error') {
        const { message } = msg.data as unknown as ErrorData;
        console.error('[Radio] Error from server:', message);
        setErrorMessage(message);
        setStatus('stopped');
      } else if (msg.event === 'dj_state') {
        const d = msg.data as unknown as DjStateData;
        console.log('[DJ] State update — locked:', d.locked, 'activeDj:', d.activeDjName);
        setDjLocked(d.locked);
        setDjUnlockAt(d.unlockAt);
        setActiveDjName(d.activeDjName);
      } else if (msg.event === 'dj_claim_ack') {
        const { granted } = msg.data as unknown as DjClaimAckData;
        console.log('[DJ] Claim ack — granted:', granted);
        if (granted) setDjPanelOpen(true);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      console.log('[WS] Connection closed — code:', event.code, 'reason:', event.reason || '(none)');
      // Guard: only the *current* socket may trigger a reconnect.
      // Without this check, React StrictMode's double-mount causes a stale
      // socket to reconnect after the new socket is already open, resulting
      // in two simultaneous connections and duplicate messages.
      if (isActiveRef.current && wsRef.current === ws) {
        const delay = reconnectDelay.current;
        console.log(`[WS] Reconnecting in ${delay}ms...`);
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(delay * 2, RECONNECT_MAX_MS);
          connectWebSocket();
        }, delay);
      }
    };

    ws.onerror = () => {
      // onclose fires right after onerror; reconnect logic lives there
      console.error('[WS] Socket error — waiting for onclose to trigger reconnect');
    };
  }, [playTrack, prefetchNextTrack]);

  // Mount: start WS; unmount: tear down
  useEffect(() => {
    isActiveRef.current = true;
    connectWebSocket();
    return () => {
      console.log('[WS] Cleaning up WebSocket on unmount');
      isActiveRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connectWebSocket]);

  // Attach audio element ended handler every render (audioRef might change)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.addEventListener('ended', handleTrackEnded);
    return () => audio.removeEventListener('ended', handleTrackEnded);
  }, [handleTrackEnded]);

  // Register Media Session action handlers (Lock Screen / Dynamic Island controls)
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => {
      audioRef.current?.play().catch(() => {});
      navigator.mediaSession.playbackState = 'playing';
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      audioRef.current?.pause();
      navigator.mediaSession.playbackState = 'paused';
    });
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10);
    });
    navigator.mediaSession.setActionHandler('seekforward', () => {
      if (audioRef.current) audioRef.current.currentTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + 10);
    });
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
    };
  // audioRef is stable; register once at mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ //
  // Public API
  // ------------------------------------------------------------------ //

  const start = useCallback(async (genres: string[], keywords: string[], language: string = 'en', feeling: string = '', advancedOptions?: AdvancedOptions) => {
    console.log('[Radio] Starting — genres:', genres, 'keywords:', keywords, 'language:', language, 'feeling:', feeling, 'advanced:', advancedOptions);
    nextTrackRef.current = null;
    clearPreloadBlob();
    clearActiveBlob();
    setNextReady(false);
    setErrorMessage(null);
    setActivityLog([]);
    setStatus('generating');
    setStatusMessage('Starting radio...');
    setProgress(0);

    // iOS WebKit (Safari and Chrome-on-iOS) requires audio.play() to be called
    // synchronously within a user gesture handler. We unlock the element here —
    // before any await — so that later play() calls from WebSocket callbacks are
    // permitted for the rest of the session. This is a silent no-op on desktop.
    const audioEl = audioRef.current;
    if (audioEl) {
      audioEl.muted = true;
      audioEl.play().catch(() => {}); // synchronous call unlocks the element on iOS
      audioEl.pause();
      audioEl.muted = false;
      audioEl.load();
      console.log('[Audio] iOS unlock: silent play/pause fired');
    }

    // Send start command over WebSocket. The server validates that this client
    // is the controller and responds via broadcast events (status, track_ready, error).
    sendWS({ event: 'start', data: { genres, keywords, language, feeling, advancedOptions } });
  }, [clearPreloadBlob, clearActiveBlob, sendWS]);

  const updateSettings = useCallback((
    genres: string[], keywords: string[], language: string = 'en',
    feeling: string = '', advancedOptions?: AdvancedOptions
  ) => {
    console.log('[Radio] Updating settings mid-session — genres:', genres, 'language:', language);
    // Do NOT touch audioRef or activeBlobUrl — current track keeps playing
    setNextReady(false);
    nextTrackRef.current = null;
    clearPreloadBlob(); // Revoke pre-fetched blob for old next track (will be discarded)
    sendWS({ event: 'reschedule', data: { genres, keywords, language, feeling, advancedOptions } });
  }, [clearPreloadBlob, sendWS]);

  const stop = useCallback(async () => {
    console.log('[Radio] Stop requested');
    audioRef.current?.pause();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
    nextTrackRef.current = null;
    clearPreloadBlob();
    clearActiveBlob();
    setNextReady(false);
    setStatus('stopped');
    setProgress(0);

    sendWS({ event: 'stop' });
  }, [clearPreloadBlob, clearActiveBlob, sendWS]);

  const unblockAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Called from a button click, so we are inside a user gesture — play() is allowed.
    console.log('[Audio] User tapped to listen — resuming from beginning');
    audio.currentTime = 0;
    audio.play()
      .then(() => setAudioBlocked(false))
      .catch((err) => console.error('[Audio] unblockAudio play() failed:', err));
  }, []);

  const saveTrack = useCallback(async (trackId: string): Promise<void> => {
    const res = await fetch(`/api/tracks/${trackId}/save`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error((err as { detail?: string }).detail ?? 'Save failed');
    }
  }, []);

  const claimDj = useCallback(() => {
    console.log('[DJ] Claiming DJ slot');
    sendWS({ event: 'dj_claim' });
  }, [sendWS]);

  const submitDj = useCallback((
    genres: string[], keywords: string[],
    language: string, feeling: string, djName: string,
  ) => {
    console.log('[DJ] Submitting DJ form — name:', djName);
    setDjPanelOpen(false);
    sendWS({ event: 'dj_submit', data: { genres, keywords, language, feeling, djName } });
  }, [sendWS]);

  const closeDjPanel = useCallback(() => setDjPanelOpen(false), []);

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
      setLocalPaused(false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    } else {
      audio.pause();
      setLocalPaused(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }
  }, []);

  const seekBackward = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, audio.currentTime - 10);
  }, []);

  const seekForward = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
  }, []);

  return {
    role,
    status,
    currentTrack,
    nextReady,
    statusMessage,
    errorMessage,
    activityLog,
    listenerCount,
    audioBlocked,
    viewers,
    audioDuration,
    saveTrack,
    start,
    stop,
    updateSettings,
    unblockAudio,
    audioRef,
    progress,
    localPaused,
    togglePlayPause,
    seekBackward,
    seekForward,
    djLocked,
    djUnlockAt,
    activeDjName,
    djPanelOpen,
    claimDj,
    submitDj,
    closeDjPanel,
  };
}
