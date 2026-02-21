export type RadioStatus =
  | 'idle'
  | 'connecting'
  | 'generating'
  | 'playing'
  | 'buffering'
  | 'stopped';

export interface Track {
  id: string;
  songTitle: string;
  tags: string;
  lyrics: string;
  bpm: number;
  keyScale: string;
  duration: number;
  audioUrl: string;
}

export interface Genre {
  id: string;
  label: string;
  icon: string;
  subgenres: string[];
}

export interface Keyword {
  id: string;
  label: string;
}

// WebSocket message shape from the server
export interface WSMessage {
  event: 'track_ready' | 'status' | 'error' | 'progress';
  data: Record<string, unknown>;
}

// Payload shapes for each event
export interface TrackReadyData {
  track: Track;
  isNext: boolean;
}

export interface StatusData {
  state: RadioStatus;
  message: string;
  nextReady: boolean;
}

export interface ErrorData {
  message: string;
}

export type ProgressStage =
  | 'llm_thinking'
  | 'llm_done'
  | 'acestep_start'
  | 'acestep_progress'
  | 'acestep_done';

export interface ActivityEntry {
  id: number;
  stage: ProgressStage;
  message: string;
}

export interface ProgressData {
  stage: ProgressStage;
  message: string;
  [key: string]: unknown;
}
