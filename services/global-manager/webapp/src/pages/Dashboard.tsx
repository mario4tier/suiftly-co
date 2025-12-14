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
  inSync: boolean;
  fullSync: boolean;
  error?: string;
}

interface LMStatusResponse {
  managers: LMStatus[];
}

interface NotificationCounts {
  total: number;
  error: number;
  warning: number;
  info: number;
}

interface Notification {
  notificationId: number;
  severity: string;
  category: string;
  code: string;
  message: string;
  details: any;
  customerId: string | null;
  invoiceId: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  createdAt: string;
}

export function Dashboard() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [lmStatus, setLmStatus] = useState<LMStatusResponse | null>(null);
  const [lmError, setLmError] = useState<string | null>(null);
  const [counts, setCounts] = useState<NotificationCounts | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notifError, setNotifError] = useState<string | null>(null);

  // Adaptive polling based on user activity
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

  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications/counts');
      if (!res.ok) return;
      const data = await res.json();
      setCounts(data);
    } catch {
      // Ignore
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    setNotifError(null);
    try {
      const url = showAcknowledged
        ? '/api/notifications'
        : '/api/notifications?acknowledged=false';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNotifications(data.notifications || []);
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : 'Failed to fetch');
      setNotifications([]);
    } finally {
      setLoading(false);
    }
  }, [showAcknowledged]);

  const acknowledgeNotification = async (id: number) => {
    await fetch(`/api/notifications/${id}/acknowledge`, { method: 'POST' });
    fetchNotifications();
    fetchCounts();
  };

  const acknowledgeAll = async () => {
    await fetch('/api/notifications/acknowledge-all', { method: 'POST' });
    fetchNotifications();
    fetchCounts();
  };

  const deleteNotification = async (id: number) => {
    await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
    fetchNotifications();
    fetchCounts();
  };

  const deleteAllAcknowledged = async () => {
    await fetch('/api/notifications/acknowledged', { method: 'DELETE' });
    fetchNotifications();
    fetchCounts();
  };

  useEffect(() => {
    const fetchAll = async () => {
      await Promise.all([fetchHealth(), fetchLMStatus(), fetchCounts()]);
      markUpdated();
    };
    fetchAll();
    const interval = setInterval(fetchAll, pollingInterval);
    return () => clearInterval(interval);
  }, [fetchHealth, fetchLMStatus, fetchCounts, pollingInterval, markUpdated]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const severityColor = (severity: string) => {
    switch (severity) {
      case 'error': return '#f87171';
      case 'warning': return '#fbbf24';
      case 'info': return '#60a5fa';
      default: return '#94a3b8';
    }
  };

  // Calculate LM sync state from status
  const getLMState = (lm: LMStatus): SyncState => {
    if (!lm.reachable) return SyncState.Down;
    if (lm.error) return SyncState.Error;
    if (lm.fullSync) return SyncState.Sync;
    if (lm.inSync) return SyncState.Sync;
    return SyncState.Pending;
  };

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

      {/* Notification Counts */}
      {counts && counts.total > 0 && (
        <div style={{
          background: '#1e293b',
          padding: '1rem',
          borderRadius: '0.5rem',
          marginBottom: '1rem',
          display: 'flex',
          gap: '1.5rem',
          alignItems: 'center'
        }}>
          <span style={{ color: '#94a3b8' }}>Unacknowledged:</span>
          {counts.error > 0 && (
            <span style={{ color: '#f87171' }}>{counts.error} errors</span>
          )}
          {counts.warning > 0 && (
            <span style={{ color: '#fbbf24' }}>{counts.warning} warnings</span>
          )}
          {counts.info > 0 && (
            <span style={{ color: '#60a5fa' }}>{counts.info} info</span>
          )}
        </div>
      )}

      {/* Notifications */}
      <div style={{
        background: '#1e293b',
        padding: '1rem',
        borderRadius: '0.5rem',
        marginBottom: '1rem'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1rem', color: '#94a3b8', margin: 0 }}>
            Notifications
          </h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <label style={{ color: '#94a3b8', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <input
                type="checkbox"
                checked={showAcknowledged}
                onChange={(e) => setShowAcknowledged(e.target.checked)}
              />
              Show acknowledged
            </label>
            {notifications.some(n => !n.acknowledged) && (
              <button
                onClick={acknowledgeAll}
                style={{
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '0.25rem',
                  cursor: 'pointer',
                  fontSize: '0.75rem'
                }}
              >
                Acknowledge All
              </button>
            )}
            {showAcknowledged && notifications.some(n => n.acknowledged) && (
              <button
                onClick={deleteAllAcknowledged}
                style={{
                  background: '#ef4444',
                  color: 'white',
                  border: 'none',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '0.25rem',
                  cursor: 'pointer',
                  fontSize: '0.75rem'
                }}
              >
                Delete Acknowledged
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <p style={{ color: '#94a3b8' }}>Loading...</p>
        ) : notifError ? (
          <p style={{ color: '#f87171' }}>Error: {notifError}</p>
        ) : notifications.length === 0 ? (
          <p style={{ color: '#64748b' }}>No notifications</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {notifications.map((n) => (
              <div
                key={n.notificationId}
                style={{
                  background: n.acknowledged ? '#0f172a' : '#1e3a5f',
                  padding: '0.75rem',
                  borderRadius: '0.25rem',
                  borderLeft: `3px solid ${severityColor(n.severity)}`,
                  opacity: n.acknowledged ? 0.6 : 1
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                      <span style={{
                        color: severityColor(n.severity),
                        fontWeight: 'bold',
                        textTransform: 'uppercase',
                        fontSize: '0.75rem'
                      }}>
                        {n.severity}
                      </span>
                      <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{n.category}</span>
                      <span style={{ color: '#475569', fontSize: '0.75rem' }}>{n.code}</span>
                    </div>
                    <p style={{ color: '#e2e8f0', margin: 0, fontSize: '0.875rem' }}>{n.message}</p>
                    {n.details && (
                      <pre style={{
                        color: '#94a3b8',
                        fontSize: '0.75rem',
                        margin: '0.5rem 0 0',
                        background: '#0f172a',
                        padding: '0.5rem',
                        borderRadius: '0.25rem',
                        overflow: 'auto',
                        maxHeight: '100px'
                      }}>
                        {JSON.stringify(n.details, null, 2)}
                      </pre>
                    )}
                    <div style={{ color: '#475569', fontSize: '0.7rem', marginTop: '0.25rem' }}>
                      {new Date(n.createdAt).toLocaleString()}
                      {n.customerId && ` | Customer: ${n.customerId}`}
                      {n.invoiceId && ` | Invoice: ${n.invoiceId}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    {!n.acknowledged && (
                      <button
                        onClick={() => acknowledgeNotification(n.notificationId)}
                        style={{
                          background: '#22c55e',
                          color: 'white',
                          border: 'none',
                          padding: '0.25rem 0.5rem',
                          borderRadius: '0.25rem',
                          cursor: 'pointer',
                          fontSize: '0.75rem'
                        }}
                      >
                        Dismiss
                      </button>
                    )}
                    <button
                      onClick={() => deleteNotification(n.notificationId)}
                      style={{
                        background: '#64748b',
                        color: 'white',
                        border: 'none',
                        padding: '0.25rem 0.5rem',
                        borderRadius: '0.25rem',
                        cursor: 'pointer',
                        fontSize: '0.75rem'
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={{ fontSize: '0.75rem', color: '#475569' }}>
        This admin dashboard is protected by firewall access only.
      </p>
    </div>
  );
}
