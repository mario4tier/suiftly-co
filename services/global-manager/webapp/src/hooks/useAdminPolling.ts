/**
 * Admin Polling Hook with Adaptive Intervals
 *
 * More aggressive polling for admin dashboard (compared to customer webapp).
 * ACTIVE polling is 1 second for fast debugging.
 *
 * Polling intervals based on user activity:
 * - Active (last 15 min): every 1 second (aggressive for debugging)
 * - Inactive > 15 min: every 30 seconds
 * - Inactive > 1 hour: every 15 minutes
 * - Inactive > 6 hours: every 1 hour
 */

import { useEffect, useRef, useCallback, useState } from 'react';

// Admin polling intervals in milliseconds (more aggressive than customer webapp)
export const ADMIN_POLLING_INTERVALS = {
  ACTIVE: 1 * 1000,              // 1 second (aggressive for debugging)
  INACTIVE_15MIN: 30 * 1000,     // 30 seconds
  INACTIVE_1HOUR: 15 * 60 * 1000, // 15 minutes
  INACTIVE_6HOURS: 60 * 60 * 1000, // 1 hour
} as const;

// Inactivity thresholds in milliseconds
const INACTIVITY_THRESHOLDS = {
  FIFTEEN_MINUTES: 15 * 60 * 1000,
  ONE_HOUR: 60 * 60 * 1000,
  SIX_HOURS: 6 * 60 * 60 * 1000,
} as const;

/**
 * Calculate polling interval based on time since last activity
 */
function calculatePollingInterval(lastActivityTime: number): number {
  const inactiveMs = Date.now() - lastActivityTime;

  if (inactiveMs < INACTIVITY_THRESHOLDS.FIFTEEN_MINUTES) {
    return ADMIN_POLLING_INTERVALS.ACTIVE;
  } else if (inactiveMs < INACTIVITY_THRESHOLDS.ONE_HOUR) {
    return ADMIN_POLLING_INTERVALS.INACTIVE_15MIN;
  } else if (inactiveMs < INACTIVITY_THRESHOLDS.SIX_HOURS) {
    return ADMIN_POLLING_INTERVALS.INACTIVE_1HOUR;
  } else {
    return ADMIN_POLLING_INTERVALS.INACTIVE_6HOURS;
  }
}

export interface AdminPollingResult {
  /** Current polling interval in ms */
  pollingInterval: number;
  /** Force update activity (e.g., on user action) */
  updateActivity: () => void;
}

/**
 * Hook that provides adaptive polling interval based on user activity.
 * Use this to set up polling in admin dashboard components.
 */
export function useAdminPolling(): AdminPollingResult {
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
        }, 500); // Throttle to twice per second for admin (more responsive)
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
  const pollingInterval = calculatePollingInterval(lastActivityTime);

  return {
    pollingInterval,
    updateActivity,
  };
}
