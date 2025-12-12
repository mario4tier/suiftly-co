/**
 * Services Status Hook with Adaptive Polling
 *
 * Unified status query for all services with activity-based polling frequency.
 * See CONTROL_PLANE_DESIGN.md for polling schedule documentation.
 *
 * Polling intervals based on user activity:
 * - Active (last 15 min): every 15 seconds
 * - Inactive > 15 min: every 30 seconds
 * - Inactive > 1 hour: every 15 minutes
 * - Inactive > 6 hours: every 1 hour
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { trpc } from '../lib/trpc';

// Polling intervals in milliseconds
const POLLING_INTERVALS = {
  ACTIVE: 15 * 1000,           // 15 seconds
  INACTIVE_15MIN: 30 * 1000,   // 30 seconds
  INACTIVE_1HOUR: 15 * 60 * 1000, // 15 minutes
  INACTIVE_6HOURS: 60 * 60 * 1000, // 1 hour
} as const;

// Inactivity thresholds in milliseconds
const INACTIVITY_THRESHOLDS = {
  FIFTEEN_MINUTES: 15 * 60 * 1000,
  ONE_HOUR: 60 * 60 * 1000,
  SIX_HOURS: 6 * 60 * 60 * 1000,
} as const;

export type OperationalStatus = 'disabled' | 'config_needed' | 'up' | 'down';
export type SyncStatus = 'synced' | 'pending';

export interface ServiceStatus {
  serviceType: string;
  operationalStatus: OperationalStatus;
  syncStatus: SyncStatus;
  configChangeVaultSeq: number;
  configNeededReason?: string;
  syncReason?: string;
}

export interface ServicesStatusResult {
  /** Status for all services */
  services: ServiceStatus[];
  /** Get status for a specific service type */
  getServiceStatus: (serviceType: 'seal' | 'grpc' | 'graphql') => ServiceStatus | undefined;
  /** Whether any service is currently syncing */
  isAnySyncing: boolean;
  /** LM fleet status */
  lmStatus: {
    lmCount: number;
    lmInSyncCount: number;
    minVaultSeq: number | null;
  };
  /** Whether we're currently loading */
  isLoading: boolean;
  /** Force an immediate refetch */
  refetch: () => void;
  /** Current polling interval in ms */
  currentPollingInterval: number;
}

/**
 * Calculate polling interval based on time since last activity
 */
function calculatePollingInterval(lastActivityTime: number): number {
  const inactiveMs = Date.now() - lastActivityTime;

  if (inactiveMs < INACTIVITY_THRESHOLDS.FIFTEEN_MINUTES) {
    return POLLING_INTERVALS.ACTIVE;
  } else if (inactiveMs < INACTIVITY_THRESHOLDS.ONE_HOUR) {
    return POLLING_INTERVALS.INACTIVE_15MIN;
  } else if (inactiveMs < INACTIVITY_THRESHOLDS.SIX_HOURS) {
    return POLLING_INTERVALS.INACTIVE_1HOUR;
  } else {
    return POLLING_INTERVALS.INACTIVE_6HOURS;
  }
}

export function useServicesStatus(): ServicesStatusResult {
  // Track last user activity time
  const [lastActivityTime, setLastActivityTime] = useState(Date.now());
  const lastActivityRef = useRef(Date.now());

  // Update activity time on user interactions
  const updateActivity = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;
    setLastActivityTime(now);
  }, []);

  // Set up activity listeners
  useEffect(() => {
    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];

    // Throttle activity updates to avoid excessive re-renders
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    const throttledUpdate = () => {
      if (!throttleTimer) {
        updateActivity();
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
        }, 1000); // Throttle to once per second
      }
    };

    events.forEach(event => {
      window.addEventListener(event, throttledUpdate, { passive: true });
    });

    // Also update on visibility change (tab focus)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        updateActivity();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also update on window focus
    const handleFocus = () => updateActivity();
    window.addEventListener('focus', handleFocus);

    return () => {
      events.forEach(event => {
        window.removeEventListener(event, throttledUpdate);
      });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      if (throttleTimer) {
        clearTimeout(throttleTimer);
      }
    };
  }, [updateActivity]);

  // Calculate current polling interval
  const currentPollingInterval = calculatePollingInterval(lastActivityTime);

  // Query with adaptive polling
  const {
    data,
    isLoading,
    refetch,
  } = trpc.services.getServicesStatus.useQuery(undefined, {
    // Dynamic polling based on activity
    refetchInterval: currentPollingInterval,
    // Refetch on window focus if user is active
    refetchOnWindowFocus: () => {
      const inactiveMs = Date.now() - lastActivityRef.current;
      return inactiveMs < INACTIVITY_THRESHOLDS.ONE_HOUR;
    },
    // Keep stale data while refetching
    staleTime: 5000,
  });

  // Helper to get status for a specific service
  const getServiceStatus = useCallback((serviceType: 'seal' | 'grpc' | 'graphql') => {
    return data?.services.find(s => s.serviceType === serviceType);
  }, [data?.services]);

  // Check if any service is syncing
  const isAnySyncing = data?.services.some(s => s.syncStatus === 'pending') ?? false;

  return {
    services: data?.services ?? [],
    getServiceStatus,
    isAnySyncing,
    lmStatus: data?.lmStatus ?? { lmCount: 0, lmInSyncCount: 0, minVaultSeq: null },
    isLoading,
    refetch: () => void refetch(),
    currentPollingInterval,
  };
}
