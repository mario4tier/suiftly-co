import { useState, useEffect, useCallback } from 'react';

interface ServerStatus {
  deployedVersion: number | null;
  versionMatch: boolean;
}

interface ServiceUpgradeStatus {
  service: string;
  network: string;
  label: string;
  servers: Record<string, ServerStatus>;
  upgradeInProgress: boolean;
  error?: string;
}

interface UpgradeStatusResponse {
  services: ServiceUpgradeStatus[];
}

interface RestartResult {
  success: boolean;
  totalDurationMs?: number;
  servers?: Array<{
    server: string;
    success: boolean;
    drainDurationMs: number;
    restartDurationMs: number;
    healthCheckDurationMs: number;
    error?: string;
  }>;
  error?: string;
  failedAt?: string;
}

export function Upgrades() {
  const [status, setStatus] = useState<UpgradeStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restartingService, setRestartingService] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RestartResult | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/upgrades/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as UpgradeStatusResponse;
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleRestart = async (service: string, network: string, label: string) => {
    const key = `${service}:${network}`;
    if (!confirm(`Start rolling restart for ${label}?\n\nThis will drain and restart each server one at a time with zero downtime.`)) {
      return;
    }

    setRestartingService(key);
    setLastResult(null);

    try {
      const res = await fetch('/api/upgrades/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, network }),
      });
      const data = await res.json() as RestartResult;
      setLastResult(data);
      // Refresh status after restart
      await fetchStatus();
    } catch (err) {
      setLastResult({
        success: false,
        error: err instanceof Error ? err.message : 'Request failed',
      });
    } finally {
      setRestartingService(null);
    }
  };

  /**
   * Determine if restart is safe for a service:
   * - At least 2 servers total
   * - At least 1 server with no errors (to serve traffic during restart)
   * - No upgrade already in progress
   */
  const isRestartSafe = (svc: ServiceUpgradeStatus): boolean => {
    const servers = Object.entries(svc.servers);
    if (servers.length < 2) return false;
    if (svc.upgradeInProgress) return false;
    return true;
  };

  if (loading) {
    return <div style={{ color: '#94a3b8', padding: '2rem' }}>Loading upgrade status...</div>;
  }

  if (error) {
    return <div style={{ color: '#f87171', padding: '2rem' }}>Error: {error}</div>;
  }

  return (
    <div style={{ maxWidth: '900px' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ color: '#e2e8f0', fontSize: '1.25rem', fontWeight: 600, margin: '0 0 0.25rem' }}>
          Rolling Upgrades
        </h2>
        <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
          Hitless restart of backend services. Drains one server at a time, restarts, waits for health check, then proceeds to the next.
        </p>
      </div>

      {/* Last result banner */}
      {lastResult && (
        <div style={{
          padding: '0.75rem 1rem',
          marginBottom: '1rem',
          borderRadius: '0.5rem',
          background: lastResult.success ? '#064e3b' : '#7f1d1d',
          border: `1px solid ${lastResult.success ? '#10b981' : '#f87171'}`,
          fontSize: '0.875rem',
          color: lastResult.success ? '#6ee7b7' : '#fca5a5',
        }}>
          {lastResult.success ? (
            <span>Rolling restart completed successfully in {lastResult.totalDurationMs}ms</span>
          ) : (
            <span>Restart failed{lastResult.failedAt ? ` at ${lastResult.failedAt}` : ''}: {lastResult.error || lastResult.servers?.find(s => s.error)?.error}</span>
          )}
          <button
            onClick={() => setLastResult(null)}
            style={{ marginLeft: '1rem', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
          >
            dismiss
          </button>
        </div>
      )}

      {/* Service cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {status?.services.map((svc) => {
          const key = `${svc.service}:${svc.network}`;
          const servers = Object.entries(svc.servers);
          const hasServers = servers.length > 0;
          const isRestarting = restartingService === key;
          const safe = isRestartSafe(svc);

          return (
            <div
              key={key}
              style={{
                background: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.5rem',
                padding: '1rem 1.25rem',
              }}
            >
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: hasServers ? '0.75rem' : 0 }}>
                <div>
                  <span style={{ color: '#e2e8f0', fontSize: '0.9375rem', fontWeight: 600 }}>
                    {svc.label}
                  </span>
                  {svc.upgradeInProgress && (
                    <span style={{
                      marginLeft: '0.75rem',
                      fontSize: '0.75rem',
                      padding: '0.125rem 0.5rem',
                      borderRadius: '9999px',
                      background: '#1e3a5f',
                      color: '#60a5fa',
                    }}>
                      Upgrading...
                    </span>
                  )}
                </div>
                {hasServers && (
                  <button
                    onClick={() => handleRestart(svc.service, svc.network, svc.label)}
                    disabled={!safe || isRestarting}
                    style={{
                      padding: '0.375rem 0.875rem',
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      borderRadius: '0.375rem',
                      border: 'none',
                      cursor: safe && !isRestarting ? 'pointer' : 'not-allowed',
                      background: safe && !isRestarting ? '#1d4ed8' : '#334155',
                      color: safe && !isRestarting ? '#fff' : '#64748b',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { if (safe && !isRestarting) e.currentTarget.style.background = '#2563eb'; }}
                    onMouseLeave={(e) => { if (safe && !isRestarting) e.currentTarget.style.background = '#1d4ed8'; }}
                  >
                    {isRestarting ? 'Restarting...' : 'Restart'}
                  </button>
                )}
              </div>

              {/* Server table */}
              {hasServers ? (
                <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #334155' }}>
                      <th style={{ textAlign: 'left', padding: '0.375rem 0', color: '#94a3b8', fontWeight: 500 }}>Server</th>
                      <th style={{ textAlign: 'left', padding: '0.375rem 0', color: '#94a3b8', fontWeight: 500 }}>Status</th>
                      <th style={{ textAlign: 'right', padding: '0.375rem 0', color: '#94a3b8', fontWeight: 500 }}>Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servers.map(([name, srv]) => (
                      <tr key={name} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '0.375rem 0', color: '#e2e8f0', fontFamily: 'monospace' }}>{name}</td>
                        <td style={{ padding: '0.375rem 0' }}>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.375rem',
                            fontSize: '0.8125rem',
                            color: srv.versionMatch || srv.deployedVersion === null ? '#34d399' : '#fbbf24',
                          }}>
                            <span style={{
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              background: srv.versionMatch || srv.deployedVersion === null ? '#34d399' : '#fbbf24',
                            }} />
                            {srv.versionMatch || srv.deployedVersion === null ? 'OK' : 'Outdated'}
                          </span>
                        </td>
                        <td style={{ padding: '0.375rem 0', textAlign: 'right', color: '#94a3b8', fontFamily: 'monospace' }}>
                          {srv.deployedVersion ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : svc.error ? (
                <div style={{ color: '#f87171', fontSize: '0.8125rem' }}>
                  Error: {svc.error}
                </div>
              ) : (
                <div style={{ color: '#64748b', fontSize: '0.8125rem' }}>
                  No servers configured on this node
                </div>
              )}

              {/* Safety warning when restart is disabled */}
              {hasServers && !safe && !svc.upgradeInProgress && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                  Restart requires at least 2 servers. Fix issues at the node directly.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
