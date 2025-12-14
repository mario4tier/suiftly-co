/**
 * Shared SyncIndicator component
 *
 * Displays sync status badge - logic for determining state lives in the caller
 */

export enum SyncState {
  Down = 'down',
  Error = 'error',
  Sync = 'sync',
  Pending = 'pending',
}

interface SyncIndicatorProps {
  state: SyncState;
  label?: string; // Optional: Custom label override
}

export function SyncIndicator({ state, label }: SyncIndicatorProps) {
  let color: string;
  let text: string;

  switch (state) {
    case SyncState.Down:
      color = '#f87171';
      text = 'Down';
      break;
    case SyncState.Error:
      color = '#f87171';
      text = 'Error';
      break;
    case SyncState.Sync:
      color = '#4ade80';
      text = 'Sync';
      break;
    case SyncState.Pending:
      color = '#fbbf24';
      text = 'Pending';
      break;
  }

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.25rem',
      padding: '0.125rem 0.5rem',
      background: `${color}20`,
      border: `1px solid ${color}`,
      borderRadius: '0.25rem',
      fontSize: '0.75rem',
      color,
      fontWeight: 'bold',
    }}>
      <span style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: color,
      }} />
      {label || text}
    </span>
  );
}
