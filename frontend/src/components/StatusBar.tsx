import { RadioStatus } from '../types';

interface StatusBarProps {
  status: RadioStatus;
  message: string;
  nextReady: boolean;
}

export function StatusBar({ status, message, nextReady }: StatusBarProps) {
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
    </div>
  );
}
