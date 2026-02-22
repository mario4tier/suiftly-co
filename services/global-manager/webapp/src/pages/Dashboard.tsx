import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAdminPollingContext } from '../contexts/AdminPollingContext';
import { SyncIndicator, SyncState } from '../components/SyncIndicator';

interface HealthStatus {
  service: string;
  timestamp: string;
}

interface LMStatus {
  name: string;
  host: string;
  reachable: boolean;
  vaults: Array<{
    type: string;
    appliedSeq: number;
    processingSeq: number | null;
  }>;
  error?: string;
}

interface LMStatusResponse {
  managers: LMStatus[];
}

interface AlarmCounts {
  total: number;
  [category: string]: number;
}

interface NotificationCounts {
  total: number;
  error: number;
  warning: number;
  info: number;
  byCategory: Record<string, number>;
}

// Categories with dedicated pages get links
const CATEGORY_PAGES: Record<string, string> = {
  billing: '/billing',
};

export function Dashboard() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [lmStatus, setLmStatus] = useState<LMStatusResponse | null>(null);
  const [lmError, setLmError] = useState<string | null>(null);
  const [alarmCounts, setAlarmCounts] = useState<AlarmCounts | null>(null);
  const [notifCounts, setNotifCounts] = useState<NotificationCounts | null>(null);

  const { pollingInterval, markUpdated } = useAdminPollingContext();

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setHealth(data);
      setHealthError(null);
    } catch (e) {
      setHealthError(e instanceof Error ? e.message : 'Unknown error');
      setHealth(null);
    }
  }, []);

  const fetchLMStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/lm/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLmStatus(data);
      setLmError(null);
    } catch (e) {
      setLmError(e instanceof Error ? e.message : 'Unknown error');
      setLmStatus(null);
    }
  }, []);

  const fetchAlarmCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/alarms/counts');
      if (!res.ok) return;
      const data = await res.json();
      setAlarmCounts(data);
    } catch {
      // Ignore
    }
  }, []);

  const fetchNotifCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications/counts');
      if (!res.ok) return;
      const data = await res.json();
      setNotifCounts(data);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    const fetchAll = async () => {
      await Promise.all([fetchHealth(), fetchLMStatus(), fetchAlarmCounts(), fetchNotifCounts()]);
      markUpdated();
    };
    fetchAll();
    const interval = setInterval(fetchAll, pollingInterval);
    return () => clearInterval(interval);
  }, [fetchHealth, fetchLMStatus, fetchAlarmCounts, fetchNotifCounts, pollingInterval, markUpdated]);

  // Calculate LM sync state from status
  const getLMState = (lm: LMStatus): SyncState => {
    if (!lm.reachable) return SyncState.Down;
    if (lm.error) return SyncState.Error;
    const allApplied = lm.vaults.every(v => v.appliedSeq > 0 && v.processingSeq === null);
    if (allApplied) return SyncState.Sync;
    return SyncState.Pending;
  };

  // Build category rows for the monitoring summary
  const categoryRows = buildCategoryRows(alarmCounts, notifCounts);
  const totalAlarms = alarmCounts?.total ?? 0;
  const totalNotifs = notifCounts?.total ?? 0;

  return (
    <div style={{ maxWidth: '900px' }}>
      {/* Quick Links */}
      <div style={{
        display: 'flex',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}>
        <Link
          to="/kvcrypt"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.75rem 1rem',
            background: '#1e3a5f',
            borderRadius: '0.5rem',
            textDecoration: 'none',
            color: '#60a5fa',
            fontSize: '0.875rem',
            border: '1px solid #334155',
          }}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
          </svg>
          KVCrypt Debug
        </Link>
      </div>

      {/* Global Manager Health Status */}
      <div style={{
        background: '#1e293b',
        padding: '1rem',
        borderRadius: '0.5rem',
        marginBottom: '1rem'
      }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem', color: '#94a3b8' }}>
          Global Manager
        </h2>
        {healthError ? (
          <p style={{ color: '#f87171' }}>Error: {healthError}</p>
        ) : health ? (
          <div style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
            <SyncIndicator state={SyncState.Sync} label="Up" />
            <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
              Last check: {new Date(health.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ) : (
          <p style={{ color: '#94a3b8' }}>Loading...</p>
        )}
      </div>

      {/* Local Manager Status */}
      <div style={{
        background: '#1e293b',
        padding: '1rem',
        borderRadius: '0.5rem',
        marginBottom: '1rem'
      }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem', color: '#94a3b8' }}>
          Local Managers
        </h2>
        {lmError ? (
          <p style={{ color: '#f87171' }}>Error: {lmError}</p>
        ) : lmStatus?.managers && lmStatus.managers.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {lmStatus.managers.map((lm, idx) => (
              <div key={idx} style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ color: '#e2e8f0', fontWeight: 'bold' }}>{lm.name}</span>
                  <SyncIndicator state={getLMState(lm)} />
                </div>
                <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>{lm.host}</span>
                {lm.error && (
                  <span style={{ color: '#f87171', fontSize: '0.75rem' }}>Error: {lm.error}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: '#94a3b8' }}>Loading...</p>
        )}
      </div>

      {/* Monitoring Summary */}
      <div style={{
        background: '#1e293b',
        padding: '1rem',
        borderRadius: '0.5rem',
        marginBottom: '1rem',
      }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem', color: '#94a3b8' }}>
          Monitoring Summary
        </h2>

        {categoryRows.length === 0 && totalAlarms === 0 && totalNotifs === 0 ? (
          <p style={{ color: '#64748b', fontSize: '0.875rem' }}>All clear — no alarms or notifications.</p>
        ) : (
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.8125rem',
          }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #334155' }}>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', color: '#64748b', fontWeight: 500, fontSize: '0.75rem' }}>Category</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: '#64748b', fontWeight: 500, fontSize: '0.75rem' }}>Alarms</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: '#64748b', fontWeight: 500, fontSize: '0.75rem' }}>Notifications</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: '#64748b', fontWeight: 500, fontSize: '0.75rem', width: '60px' }}></th>
              </tr>
            </thead>
            <tbody>
              {categoryRows.map((row) => {
                const hasAlarms = row.alarms > 0;
                const pagePath = CATEGORY_PAGES[row.category];
                return (
                  <tr
                    key={row.category}
                    style={{
                      borderBottom: '1px solid #334155',
                      background: hasAlarms ? '#7f1d1d11' : 'transparent',
                    }}
                  >
                    <td style={{
                      padding: '0.5rem 0.75rem',
                      color: hasAlarms ? '#fca5a5' : '#e2e8f0',
                      fontWeight: hasAlarms ? 600 : 400,
                    }}>
                      {row.category}
                    </td>
                    <td style={{
                      padding: '0.5rem 0.75rem',
                      textAlign: 'right',
                      color: hasAlarms ? '#ef4444' : '#64748b',
                      fontWeight: hasAlarms ? 700 : 400,
                    }}>
                      {row.alarms}
                    </td>
                    <td style={{
                      padding: '0.5rem 0.75rem',
                      textAlign: 'right',
                      color: row.notifications > 0 ? '#f59e0b' : '#64748b',
                    }}>
                      {row.notifications}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>
                      {pagePath && (
                        <Link
                          to={pagePath}
                          style={{
                            color: '#60a5fa',
                            fontSize: '0.75rem',
                            textDecoration: 'none',
                          }}
                        >
                          View &rarr;
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}

              {/* Total row */}
              {categoryRows.length > 1 && (
                <tr style={{ borderTop: '2px solid #475569' }}>
                  <td style={{ padding: '0.5rem 0.75rem', color: '#94a3b8', fontWeight: 600 }}>Total</td>
                  <td style={{
                    padding: '0.5rem 0.75rem',
                    textAlign: 'right',
                    color: totalAlarms > 0 ? '#ef4444' : '#64748b',
                    fontWeight: 600,
                  }}>
                    {totalAlarms}
                  </td>
                  <td style={{
                    padding: '0.5rem 0.75rem',
                    textAlign: 'right',
                    color: totalNotifs > 0 ? '#f59e0b' : '#64748b',
                    fontWeight: 600,
                  }}>
                    {totalNotifs}
                  </td>
                  <td></td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <p style={{ fontSize: '0.75rem', color: '#475569' }}>
        This admin dashboard is protected by firewall access only.
      </p>
    </div>
  );
}

// Build merged category rows from alarm counts + notification counts
// Only includes categories that have at least one alarm or notification
function buildCategoryRows(
  alarmCounts: AlarmCounts | null,
  notifCounts: NotificationCounts | null,
): Array<{ category: string; alarms: number; notifications: number }> {
  const categories = new Set<string>();

  // Collect categories from alarms (skip 'total' key)
  if (alarmCounts) {
    for (const key of Object.keys(alarmCounts)) {
      if (key !== 'total') categories.add(key);
    }
  }

  // Collect categories from notifications
  if (notifCounts?.byCategory) {
    for (const key of Object.keys(notifCounts.byCategory)) {
      categories.add(key);
    }
  }

  const rows = Array.from(categories)
    .map(cat => ({
      category: cat,
      alarms: (alarmCounts && cat in alarmCounts) ? (alarmCounts as Record<string, number>)[cat] : 0,
      notifications: notifCounts?.byCategory?.[cat] ?? 0,
    }))
    .filter(r => r.alarms > 0 || r.notifications > 0)
    .sort((a, b) => {
      // Sort: categories with alarms first, then by name
      if (a.alarms > 0 && b.alarms === 0) return -1;
      if (a.alarms === 0 && b.alarms > 0) return 1;
      return a.category.localeCompare(b.category);
    });

  return rows;
}
