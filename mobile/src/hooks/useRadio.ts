import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import RNBlobUtil from 'react-native-blob-util';
import TrackPlayer, {
  Event,
  State,
  useTrackPlayerEvents,
  Capability,
  IOSCategory,
} from 'react-native-track-player';
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
  ReactionState,
  ReactionUpdateData,
} from '@radio/shared';
import { BACKEND_URL, WS_URL } from '../config';

export interface UseRadioReturn {
  role: ClientRole | null;
  status: RadioStatus;
  currentTrack: Track | null;
  nextReady: boolean;
  statusMessage: string;
  errorMessage: string | null;
  activityLog: ActivityEntry[];
  listenerCount: number;
  viewers: ViewerInfo[];
  audioDuration: number | null;
  saveTrack: (trackId: string) => Promise<void>;
  start: (genres: string[], keywords: string[], language: string, feeling?: string, advancedOptions?: AdvancedOptions, djName?: string) => Promise<void>;
  stop: () => Promise<void>;
  updateSettings: (genres: string[], keywords: string[], language: string, feeling?: string, advancedOptions?: AdvancedOptions) => void;
  progress: number;
  localPaused: boolean;
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
  const [viewers, setViewers] = useState<ViewerInfo[]>([]);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [localPaused, setLocalPaused] = useState(true);
  const activityIdRef = useRef(0);

  // DJ mode state
  const [djLocked, setDjLocked] = useState(true);
  const [djUnlockAt, setDjUnlockAt] = useState(0);
  const [activeDjName, setActiveDjName] = useState('');
  const [djPanelOpen, setDjPanelOpen] = useState(false);

  // Reaction state
  const emptyReaction: ReactionState = { thumbUp: 0, thumbDown: 0, userReaction: null };
  const [reactionState, setReactionState] = useState<ReactionState>(emptyReaction);
  const reactionStateRef = useRef<ReactionState>(emptyReaction);

  const roleRef = useRef<ClientRole | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nextTrackRef = useRef<Track | null>(null);
  const currentTrackRef = useRef<Track | null>(null);
  const localPausedRef = useRef<boolean>(true);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActiveRef = useRef(false);
  const playerReadyRef = useRef(false);
  // True only after TrackPlayer.add() succeeds for the next track.
  // nextTrackRef being set just means we received track_ready — the download
  // may still be in-flight. nextQueuedRef confirms it's in RNTP's queue.
  const nextQueuedRef = useRef(false);

  // ------------------------------------------------------------------ //
  // Audio download helper — mirrors web app's Blob URL pre-fetch.
  // Downloads the MP3 to the app cache directory so RNTP plays a local
  // file:// URI instead of a chunked HTTP stream (which iOS AVPlayer
  // misidentifies as ICY/HLS and fails with err=-12640/-12860).
  // ------------------------------------------------------------------ //

  const downloadAudio = useCallback(async (track: Track): Promise<string> => {
    // Use documentDirectory (not cacheDirectory): iOS can delete the Caches dir
    // for backgrounded apps under memory pressure, causing FigFilePlayer -12864
    // when RNTP tries to open the queued next-track file. The Documents dir is
    // persistent for the lifetime of the app install.
    const localUri = `${FileSystem.documentDirectory}track_${track.id}.mp3`;
    const info = await FileSystem.getInfoAsync(localUri);
    if (info.exists) {
      console.log('[Audio] Cache hit for:', track.songTitle);
      return localUri;
    }
    const url = `${BACKEND_URL}${track.audioUrl}`;
    console.log('[Audio] Downloading to cache:', track.songTitle, '—', url);
    // Use react-native-blob-util with IOSBackgroundTask: true so iOS schedules
    // this as a proper background URLSession transfer — not throttled like
    // FileSystem.downloadAsync which uses a random-UUID background session.
    await RNBlobUtil.config({
      path: localUri.replace('file://', ''),
      IOSBackgroundTask: true,
    }).fetch('GET', url);
    console.log('[Audio] Download complete:', track.songTitle);
    return localUri;
  }, []);

  // ------------------------------------------------------------------ //
  // TrackPlayer setup
  // ------------------------------------------------------------------ //

  useEffect(() => {
    let mounted = true;
    TrackPlayer.setupPlayer({
      maxCacheSize: 1024 * 5, // 5 MB cache
      // Keep the audio session alive when the screen is locked or the app is
      // backgrounded. IOSCategory.Playback is RNTP's default but explicit here
      // for clarity. autoHandleInterruptions ensures RNTP automatically resumes
      // after interruptions (phone calls, Siri, notification sounds) instead of
      // leaving playback permanently stopped.
      iosCategory: IOSCategory.Playback,
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
        jumpInterval: 10,
      });
      playerReadyRef.current = true;
      console.log('[RNTP] Player ready');
    }).catch((err: Error) => {
      // setupPlayer throws if called a second time (e.g. Fast Refresh) — safe to ignore
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
        // Player not ready or no track loaded — ignore
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // ------------------------------------------------------------------ //
  // RNTP event: track changed (current track ended → next started)
  // ------------------------------------------------------------------ //

  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], async (event) => {
    if (event.index === undefined || event.index === null) return;
    // A new track became active — this means the previous one ended.
    // We only care about transitions away from index 0 (current) to index 1 (next).
    if (event.index > 0 && nextTrackRef.current) {
      console.log('[RNTP] Track changed — advancing to next');
      const next = nextTrackRef.current;
      nextTrackRef.current = null;
      nextQueuedRef.current = false;
      setNextReady(false);
      setStatus('playing');
      setCurrentTrack(next);
      currentTrackRef.current = next;
      setProgress(0);

      // Reset reactions and fetch fresh counts
      const resetReaction: ReactionState = { thumbUp: 0, thumbDown: 0, userReaction: null };
      setReactionState(resetReaction);
      reactionStateRef.current = resetReaction;
      fetch(`${BACKEND_URL}/api/tracks/${next.id}/reactions`)
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

      // Remove the old track from queue (shift down)
      await TrackPlayer.remove(0);
      sendWS({ event: 'track_ended' });
    }
  });

  useTrackPlayerEvents([Event.PlaybackQueueEnded], () => {
    // Queue fully exhausted. Two cases require recovery:
    // 1. No next track at all — normal gap between tracks.
    // 2. nextTrackRef is set but nextQueuedRef is false — download was suspended
    //    by iOS in background and never completed, so TrackPlayer.add() was never
    //    called. The ref is set but the queue is empty.
    if (!nextTrackRef.current || !nextQueuedRef.current) {
      console.log('[RNTP] Queue ended — nextTrack:', nextTrackRef.current?.songTitle ?? 'none', '/ queued:', nextQueuedRef.current);
//      nextTrackRef.current = null;
      nextQueuedRef.current = false;
      setNextReady(false);
      setStatus('buffering');
      setStatusMessage('Buffering next track...');
//      sendWS({ event: 'track_ended' });
    }
  });

  // Log every RNTP state transition and playback error.
  // Visible in Xcode Console (Window → Devices → Open Console) for Release builds.
  useTrackPlayerEvents([Event.PlaybackState], (event) => {
    console.log('[RNTP] State →', event.state);
  });

  useTrackPlayerEvents([Event.PlaybackError], (event) => {
    console.error('[RNTP] Playback error — code:', event.code, 'message:', event.message);
  });

  // ------------------------------------------------------------------ //
  // Internal helpers
  // ------------------------------------------------------------------ //

  const sendWS = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      console.log('[WS] Sending:', data);
    } else {
      console.warn('[WS] Cannot send — socket not open');
    }
  }, []);

  const playTrack = useCallback(async (track: Track) => {
    console.log('[Audio] Playing track:', track.songTitle);
    setCurrentTrack(track);
    currentTrackRef.current = track;
    setProgress(0);
    setAudioDuration(null);
    setErrorMessage(null);

    const keepPaused = localPausedRef.current;
    if (!keepPaused) {
      setLocalPaused(false);
      localPausedRef.current = false;
    }

    if (!playerReadyRef.current) return;
    try {
      // Download to local cache so RNTP plays a file:// URI — iOS AVPlayer
      // mis-handles chunked HTTP streams as ICY/HLS (err=-12640/-12860).
      const localUri = await downloadAudio(track);
      await TrackPlayer.reset();
      await TrackPlayer.add({
        id: track.id,
        url: localUri,
        title: track.songTitle,
        artist: track.genre,
        album: 'Generative Radio',
        duration: track.duration,
      });
      if (!keepPaused) {
        await TrackPlayer.play();
      }
    } catch (err) {
      console.error('[Audio] playTrack failed:', err);
    }
  }, [downloadAudio]);

  const prefetchNextTrack = useCallback(async (track: Track) => {
    console.log('[Audio] Pre-fetching next track to cache:', track.songTitle);
    if (!playerReadyRef.current) return;
    try {
      // Download to local cache in the background while the current track plays.
      // Once done, add to RNTP queue so it's ready for instant playback.
      const localUri = await downloadAudio(track);
      // Guard: if iOS suspended the download and it completed late, the next
      // track slot may have been reassigned. Discard rather than queue stale audio.
      if (nextTrackRef.current?.id !== track.id) {
        console.log('[Audio] Prefetch completed but track superseded — discarding:', track.songTitle);
        return;
      }
      await TrackPlayer.add({
        id: track.id,
        url: localUri,
        title: track.songTitle,
        artist: track.genre,
        album: 'Generative Radio',
        duration: track.duration,
      });
      nextQueuedRef.current = true;
      console.log('[Audio] Next track cached and queued:', track.songTitle);

      // If RNTP stopped while the download was in-flight (the current track ended
      // before prefetch completed), kick-start the newly queued track immediately
      // rather than waiting for play_now watchdog (which fires after 150-300 s).
      const rntpState = await TrackPlayer.getState();
      const rntpActive = rntpState === State.Playing
        || rntpState === State.Buffering
        || rntpState === State.Loading;
      if (!rntpActive && !localPausedRef.current) {
        console.log('[Audio] Player stopped after late prefetch — kick-starting');
        try {
          const queue = await TrackPlayer.getQueue();
          if (queue.length > 1) {
            // Ended track still occupies index 0 — skip to the newly added track
            await TrackPlayer.skip(queue.length - 1);
          }
          await TrackPlayer.play();
        } catch (e) {
          console.error('[Audio] Kick-start after late prefetch failed:', e);
        }
      }
    } catch (err) {
      console.error('[Audio] prefetchNextTrack failed:', err);
    }
  }, [downloadAudio]);

  // ------------------------------------------------------------------ //
  // WebSocket connection
  // ------------------------------------------------------------------ //

  const connectWebSocket = useCallback(() => {
    if (!isActiveRef.current) return;
    console.log('[WS] Connecting to', WS_URL);
    setStatus('connecting');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connection established');
      reconnectDelay.current = RECONNECT_BASE_MS;
      // Keep-alive ping every 25 s — iOS kills idle TCP connections in background
      // even with UIBackgroundModes:audio. Without this the WS silently dies and
      // track_ended is never delivered, stalling the radio loop.
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log('[WS] Ping');
          ws.send(JSON.stringify({ event: 'ping' }));
        } else {
          console.warn('[WS] Ping skipped — socket state:', ws.readyState);
        }
      }, 20_000);
    };

    ws.onmessage = async (event: MessageEvent) => {
      let msg: WSMessage;
      try {
        msg = JSON.parse(event.data as string) as WSMessage;
      } catch {
        console.error('[WS] Failed to parse message:', event.data);
        return;
      }
      console.log('[WS] Received:', msg.event);

      if (msg.event === 'role_assigned') {
        const { role: assignedRole } = msg.data as unknown as RoleAssignedData;
        roleRef.current = assignedRole;
        setRole(assignedRole);
      } else if (msg.event === 'track_ready') {
        const { track, isNext } = msg.data as unknown as TrackReadyData;
        if (!isNext) {
          console.log('[Radio] track_ready (current) received:', track.songTitle, '/ currentId:', currentTrackRef.current?.id ?? 'none');
          const alreadyPlayingId = currentTrackRef.current?.id;

          if (alreadyPlayingId === track.id) {
            // WS reconnected mid-track — RNTP is already playing this track; skip reset.
            // Mirrors the duplicate-protection in the web hook.
            console.log('[Radio] track_ready (current) — already playing, skip reset:', track.songTitle);
            setStatus('playing');
          } else if (alreadyPlayingId && alreadyPlayingId !== track.id) {
            // currentTrackRef has a different track than the server's current track.
            // Only re-sync if RNTP is actively playing — meaning it auto-advanced while
            // WS was dead and the backend hasn't caught up yet.
            // If RNTP is stopped/idle (queue exhausted normally), fall through to playTrack()
            // so we don't send a spurious track_ended that skips the incoming track.
            const rtpState = await TrackPlayer.getState();
            const isRntpPlaying = rtpState === State.Playing
              || rtpState === State.Buffering
              || rtpState === State.Loading;
            if (isRntpPlaying) {
              console.log('[Radio] WS reconnect: RNTP ahead of backend, sending track_ended to sync');
              sendWS({ event: 'track_ended' });
              setStatus('playing');
            } else {
              // RNTP has stopped — queue was exhausted, backend is now sending the next track.
              console.log('[Radio] track_ready (current) after queue end:', track.songTitle);
              nextTrackRef.current = null;
              setNextReady(false);
              setStatus('playing');
              playTrack(track);
            }
          } else {
            // No current track — normal first-play flow.
            console.log('[Radio] track_ready (current):', track.songTitle);
            nextTrackRef.current = null;
            setNextReady(false);
            setStatus('playing');
            playTrack(track);
            // Fetch reactions for this track
            const resetReaction: ReactionState = { thumbUp: 0, thumbDown: 0, userReaction: null };
            setReactionState(resetReaction);
            reactionStateRef.current = resetReaction;
            fetch(`${BACKEND_URL}/api/tracks/${track.id}/reactions`)
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
          }
        } else {
          console.log('[Radio] track_ready (next, pre-queuing):', track.songTitle);
          nextTrackRef.current = track;
          setNextReady(true);
          prefetchNextTrack(track);
        }
      } else if (msg.event === 'play_now') {
        // Backend watchdog: fires when the backend thinks the client should be
        // playing but hasn't started. Happens when track_ready(isNext=false) was
        // lost due to a network hiccup right after we sent track_ended.
        // Directly start the track from the payload rather than sending another
        // track_ended (which would just loop).
        const d = msg.data as unknown as { track: Track };
        if (!localPausedRef.current) {
          const rtpState = await TrackPlayer.getState();
          const isPlaying = rtpState === State.Playing
            || rtpState === State.Buffering
            || rtpState === State.Loading;
          if (isPlaying && currentTrackRef.current?.id === d.track.id) {
            console.log('[Radio] play_now — already playing correct track, ignoring');
          } else if (!isPlaying) {
            console.log('[Radio] play_now — RNTP stopped, recovering with:', d.track.songTitle);
            nextTrackRef.current = null;
            nextQueuedRef.current = false;
            setNextReady(false);
            setStatus('playing');
            playTrack(d.track);
          } else {
            console.log('[Radio] play_now — RNTP playing different track, ignoring');
          }
        }
      } else if (msg.event === 'status') {
        const { state, message, nextReady: nr } = msg.data as unknown as StatusData;
        setStatus(state);
        setStatusMessage(message);
        setNextReady(nr);
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
        setStatus('stopped');
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
        if (currentTrackRef.current?.id === d.trackId) {
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
  }, [playTrack, prefetchNextTrack]);

  // Mount: start WS; unmount: tear down
  useEffect(() => {
    isActiveRef.current = true;
    connectWebSocket();
    return () => {
      isActiveRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connectWebSocket]);

  // AppState: retry play when app comes to foreground (equivalent of visibilitychange)
  useEffect(() => {
    const handleAppState = async (nextState: AppStateStatus) => {
      console.log('[AppState]', nextState);
      if (nextState !== 'active') return;
      if (localPausedRef.current) return;
      try {
        const state = await TrackPlayer.getState();
        console.log('[Audio] App foregrounded — RNTP state:', state);
        if (state !== State.Playing && playerReadyRef.current) {
          console.log('[Audio] Resuming playback after foreground');
          await TrackPlayer.play();
        }
      } catch {
        // Ignore if player not ready
      }
    };
    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, []);

  // ------------------------------------------------------------------ //
  // Public API
  // ------------------------------------------------------------------ //

  const start = useCallback(async (
    genres: string[], keywords: string[], language = 'en',
    feeling = '', advancedOptions?: AdvancedOptions, djName = ''
  ) => {
    nextTrackRef.current = null;
    setNextReady(false);
    setErrorMessage(null);
    setActivityLog([]);
    setStatus('generating');
    setStatusMessage('Starting radio...');
    setProgress(0);
    setLocalPaused(false);
    localPausedRef.current = false;

    if (playerReadyRef.current) {
      try { await TrackPlayer.reset(); } catch { /* ignore */ }
    }

    sendWS({ event: 'start', data: { genres, keywords, language, feeling, advancedOptions, djName } });
  }, [sendWS]);

  const updateSettings = useCallback((
    genres: string[], keywords: string[], language = 'en',
    feeling = '', advancedOptions?: AdvancedOptions
  ) => {
    setNextReady(false);
    nextTrackRef.current = null;
    sendWS({ event: 'reschedule', data: { genres, keywords, language, feeling, advancedOptions } });
  }, [sendWS]);

  const stop = useCallback(async () => {
    if (playerReadyRef.current) {
      try {
        await TrackPlayer.pause();
        await TrackPlayer.reset();
      } catch { /* ignore */ }
    }
    nextTrackRef.current = null;
    setNextReady(false);
    setStatus('stopped');
    setProgress(0);
    setLocalPaused(true);
    localPausedRef.current = true;
    sendWS({ event: 'stop' });
  }, [sendWS]);

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
      const state = await TrackPlayer.getState();
      if (state === State.Playing) {
        await TrackPlayer.pause();
        setLocalPaused(true);
        localPausedRef.current = true;
      } else {
        await TrackPlayer.play();
        setLocalPaused(false);
        localPausedRef.current = false;
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
    } catch { /* ignore */ }
  }, []);

  const seekForward = useCallback(async () => {
    if (!playerReadyRef.current) return;
    try {
      const [pos, dur] = await Promise.all([TrackPlayer.getPosition(), TrackPlayer.getDuration()]);
      await TrackPlayer.seekTo(Math.min(dur, pos + 10));
    } catch { /* ignore */ }
  }, []);

  return {
    role, status, currentTrack, nextReady, statusMessage, errorMessage,
    activityLog, listenerCount, viewers, audioDuration, saveTrack,
    start, stop, updateSettings,
    progress, localPaused, togglePlayPause, seekBackward, seekForward,
    djLocked, djUnlockAt, activeDjName, djPanelOpen,
    claimDj, submitDj, closeDjPanel,
    reactionState, react,
  };
}
