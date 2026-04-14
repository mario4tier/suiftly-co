/**
 * Admin Polling Context
 *
 * Provides polling state (interval, last update time) to all components.
 * Pages update the lastUpdate when they fetch data, Layout displays it.
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useAdminPolling } from '../hooks/useAdminPolling';

interface GMHealth {
  status: string;
  service: string;
  timestamp: string;
  processingSuspended?: boolean;
  vaults?: Record<string, unknown>;
}

interface AdminPollingContextValue {
  /** Current polling interval in ms */
  pollingInterval: number;
  /** Last successful data fetch time */
  lastUpdate: Date | null;
  /** Call this after each successful fetch */
  markUpdated: () => void;
  /** GM health data (polled centrally — don't re-fetch in pages) */
  gmHealth: GMHealth | null;
  /** GM health fetch error (null if healthy) */
  gmHealthError: string | null;
  /** GM processing suspended (debounced — only true after 10s) */
  gmSuspended: boolean;
  /** Resume GM processing */
  resumeGM: () => Promise<void>;
}

const AdminPollingContext = createContext<AdminPollingContextValue | null>(null);

const SUSPEND_DEBOUNCE_MS = 10_000;

export function AdminPollingProvider({ children }: { children: ReactNode }) {
  const { pollingInterval } = useAdminPolling();
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [gmHealth, setGmHealth] = useState<GMHealth | null>(null);
  const [gmHealthError, setGmHealthError] = useState<string | null>(null);
  const [rawSuspended, setRawSuspended] = useState(false);
  const [gmSuspended, setGmSuspended] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markUpdated = useCallback(() => {
    setLastUpdate(new Date());
  }, []);

  // Poll GM health centrally (pages should read from context, not re-fetch)
  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setGmHealth(data);
      setGmHealthError(null);
      setRawSuspended(data.processingSuspended ?? false);
    } catch (e) {
      setGmHealthError(e instanceof Error ? e.message : 'Unknown error');
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, pollingInterval);
    return () => clearInterval(interval);
  }, [fetchHealth, pollingInterval]);

  // Debounce: only surface suspended after 10s to avoid flash during tests
  useEffect(() => {
    if (rawSuspended) {
      timerRef.current = setTimeout(() => setGmSuspended(true), SUSPEND_DEBOUNCE_MS);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      setGmSuspended(false);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [rawSuspended]);

  const resumeGM = useCallback(async () => {
    await fetch('/api/test/processing/resume', { method: 'POST' });
    setRawSuspended(false);
    setGmSuspended(false);
    fetchHealth();
  }, [fetchHealth]);

  return (
    <AdminPollingContext.Provider value={{ pollingInterval, lastUpdate, markUpdated, gmHealth, gmHealthError, gmSuspended, resumeGM }}>
      {children}
    </AdminPollingContext.Provider>
  );
}

export function useAdminPollingContext(): AdminPollingContextValue {
  const context = useContext(AdminPollingContext);
  if (!context) {
    throw new Error('useAdminPollingContext must be used within AdminPollingProvider');
  }
  return context;
}
