import { RadioStatus } from '../types';

interface StatusBarProps {
  status: RadioStatus;
  message: string;
  nextReady: boolean;
  listenerCount: number;
}

export function StatusBar({ status, message, nextReady, listenerCount }: StatusBarProps) {
  const dotClass =
    status === 'playing' && nextReady
      ? 'status-dot status-dot--green'
      : status === 'playing'
        ? 'status-dot status-dot--amber status-dot--pulse'
        : status === 'buffering'
          ? 'status-dot status-dot--amber status-dot--pulse'
          : status === 'generating'
            ? 'status-dot status-dot--amber status-dot--pulse'
            : 'status-dot status-dot--dim';

  const displayMessage =
    message ||
    (status === 'generating'
      ? 'Generating your first track...'
      : status === 'buffering'
        ? 'Buffering next track...'
        : status === 'playing' && nextReady
          ? 'Playing — next track ready'
          : status === 'playing'
            ? 'Playing — generating next track...'
            : '');

  return (
    <div className="status-bar">
      <span className={dotClass} />
      <span className="status-bar__message">{displayMessage}</span>
      {(status === 'generating' || status === 'buffering') && (
        <span className="status-spinner" />
      )}
      {listenerCount > 0 && (
        <span className="status-bar__listeners" title={`${listenerCount} listener${listenerCount !== 1 ? 's' : ''} connected`}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
          </svg>
          {listenerCount}
        </span>
      )}
    </div>
  );
}
