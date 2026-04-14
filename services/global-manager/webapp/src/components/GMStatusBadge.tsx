/**
 * GM Processing Status Badge
 *
 * Shows Up/SUSPENDED state. Reads from AdminPollingContext (global debounce).
 */

import { useAdminPollingContext } from '../contexts/AdminPollingContext';
import { SyncIndicator, SyncState } from './SyncIndicator';

interface GMStatusBadgeProps {
  showResumeButton?: boolean;
}

export function GMStatusBadge({ showResumeButton = false }: GMStatusBadgeProps) {
  const { gmSuspended, resumeGM } = useAdminPollingContext();

  return (
    <>
      <SyncIndicator
        state={gmSuspended ? SyncState.Error : SyncState.Sync}
        label={gmSuspended ? 'SUSPENDED' : 'Up'}
      />
      {gmSuspended && showResumeButton && (
        <button
          onClick={resumeGM}
          style={{
            background: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: '0.25rem',
            padding: '0.25rem 0.75rem',
            cursor: 'pointer',
            fontWeight: 'bold',
            fontSize: '0.8rem',
            marginLeft: '0.5rem',
          }}
        >
          Resume
        </button>
      )}
    </>
  );
}
