import { useState, useEffect, useCallback } from 'react';
import { useAdminPolling } from './hooks/useAdminPolling';

interface HealthStatus {
  status: string;
  service: string;
  timestamp: string;
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

function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [counts, setCounts] = useState<NotificationCounts | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notifError, setNotifError] = useState<string | null>(null);

  // Adaptive polling based on user activity
  const { pollingInterval } = useAdminPolling();

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
    fetchHealth();
    fetchCounts();
    const interval = setInterval(() => {
      fetchHealth();
      fetchCounts();
    }, pollingInterval);
    return () => clearInterval(interval);
  }, [fetchHealth, fetchCounts, pollingInterval]);

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

  return (
    <div style={{ padding: '2rem', maxWidth: '1000px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem', color: '#60a5fa' }}>
        Suiftly Admin Dashboard
      </h1>

      {/* Health Status */}
      <div style={{
        background: '#1e293b',
        padding: '1rem',
        borderRadius: '0.5rem',
        marginBottom: '1rem'
      }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem', color: '#94a3b8' }}>
          Global Manager Status
        </h2>
        {healthError ? (
          <p style={{ color: '#f87171' }}>Error: {healthError}</p>
        ) : health ? (
          <div style={{ display: 'flex', gap: '2rem' }}>
            <p><strong>Status:</strong> <span style={{ color: '#4ade80' }}>{health.status}</span></p>
            <p><strong>Service:</strong> {health.service}</p>
            <p><strong>Last check:</strong> {new Date(health.timestamp).toLocaleString()}</p>
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

export default App;
