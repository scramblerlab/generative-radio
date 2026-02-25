export type RadioStatus =
  | 'idle'
  | 'connecting'
  | 'generating'
  | 'playing'
  | 'buffering'
  | 'stopped';

export type ClientRole = 'controller' | 'viewer';

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
  category: string;
}

export interface SessionInfo {
  genre: string;
  keywords: string[];
  language: string;
}

export interface AdvancedOptions {
  timeSignature?: string;   // "2", "3", "4", "6", or undefined (auto)
  inferenceSteps: number;   // 4–16, default 8
  model: string;            // "turbo", "turbo-shift1", "turbo-shift3", "turbo-continuous"
}

export interface Language {
  code: string;   // ISO 639-1 code, or "instrumental"
  label: string;  // Display name (may be in native script)
}

// WebSocket message shape from the server
export interface WSMessage {
  event: 'track_ready' | 'status' | 'error' | 'progress' | 'listener_count' | 'role_assigned' | 'viewer_list';
  data: Record<string, unknown>;
}

export interface ListenerCountData {
  count: number;
}

export interface RoleAssignedData {
  role: ClientRole;
}

// Payload shapes for each event
export interface TrackReadyData {
  track: Track;
  isNext: boolean;
  seed?: string;
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

export interface ViewerInfo {
  ip: string;
  connectedAt: number; // Unix timestamp (seconds)
}

export interface ViewerListData {
  viewers: ViewerInfo[];
}
