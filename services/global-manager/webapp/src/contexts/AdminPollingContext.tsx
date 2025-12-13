/**
 * Admin Polling Context
 *
 * Provides polling state (interval, last update time) to all components.
 * Pages update the lastUpdate when they fetch data, Layout displays it.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { useAdminPolling } from '../hooks/useAdminPolling';

interface AdminPollingContextValue {
  /** Current polling interval in ms */
  pollingInterval: number;
  /** Last successful data fetch time */
  lastUpdate: Date | null;
  /** Call this after each successful fetch */
  markUpdated: () => void;
}

const AdminPollingContext = createContext<AdminPollingContextValue | null>(null);

export function AdminPollingProvider({ children }: { children: ReactNode }) {
  const { pollingInterval } = useAdminPolling();
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const markUpdated = useCallback(() => {
    setLastUpdate(new Date());
  }, []);

  return (
    <AdminPollingContext.Provider value={{ pollingInterval, lastUpdate, markUpdated }}>
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
