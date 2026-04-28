import { useCallback, useEffect, useMemo, useState } from 'react';

export type ProbeStatus = 'green' | 'red' | 'gray';

interface ProbeResult {
  fqdn: string;
  port: number;
  pipeline: 'A' | 'B' | 'C';
  provider: string;
  ip: string;
  peerIp: string | null;
  resolvedFromDns: boolean;
  status: ProbeStatus;
  rawStatus: ProbeStatus;
  consecutiveFailures: number;
  reason: string;
  notAfter: string | null;
  notBefore: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
  subject: string | null;
  altNames: string[];
  probedAt: string;
}

interface ProbeListResponse {
  probedAt: string | null;
  intervalMs: number;
  rollupStatus: ProbeStatus;
  results: ProbeResult[];
}

const POLL_MS = 60_000;

export const STATUS_COLORS: Record<ProbeStatus, string> = {
  green: '#4ade80',
  red: '#ef4444',
  gray: '#64748b',
};

export const STATUS_LABELS: Record<ProbeStatus, string> = {
  green: 'OK',
  red: 'Problem',
  gray: 'No data',
};

export function StatusDot({ status, size = 10 }: { status: ProbeStatus; size?: number }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: STATUS_COLORS[status],
        verticalAlign: 'middle',
      }}
      aria-label={STATUS_LABELS[status]}
    />
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatInterval(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

export function Certs() {
  const [data, setData] = useState<ProbeListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshingFqdn, setRefreshingFqdn] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch('/api/certs/list');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as ProbeListResponse;
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchList();
    const t = setInterval(fetchList, POLL_MS);
    return () => clearInterval(t);
  }, [fetchList]);

  const refreshFqdn = useCallback(async (fqdn: string) => {
    setRefreshingFqdn(fqdn);
    setRefreshError(null);
    try {
      const res = await fetch('/api/certs/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fqdn }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json() as ProbeListResponse;
      setData(body);
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshingFqdn(null);
    }
  }, []);

  const grouped = useMemo(() => {
    if (!data) return [];
    const order: string[] = [];
    const map = new Map<string, ProbeResult[]>();
    for (const r of data.results) {
      if (!map.has(r.fqdn)) {
        order.push(r.fqdn);
        map.set(r.fqdn, []);
      }
      map.get(r.fqdn)!.push(r);
    }
    return order.map(fqdn => {
      const rows = map.get(fqdn)!;
      const groupStatus: ProbeStatus =
        rows.some(r => r.status === 'red') ? 'red'
        : rows.every(r => r.status === 'green') ? 'green'
        : 'gray';
      return { fqdn, pipeline: rows[0].pipeline, port: rows[0].port, rows, groupStatus };
    });
  }, [data]);

  if (loading && !data) {
    return <div style={{ color: '#94a3b8' }}>Loading cert probes…</div>;
  }
  if (error && !data) {
    return <div style={{ color: STATUS_COLORS.red }}>Error: {error}</div>;
  }
  if (!data) return null;

  const total = data.results.length;
  const reds = data.results.filter(r => r.status === 'red').length;
  const greens = data.results.filter(r => r.status === 'green').length;

  return (
    <div style={{ color: '#e2e8f0', fontSize: '0.875rem' }}>
      <div
        style={{
          background: '#1e293b',
          border: `1px solid ${STATUS_COLORS[data.rollupStatus]}`,
          borderRadius: '0.5rem',
          padding: '0.875rem 1rem',
          marginBottom: '1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.875rem',
          flexWrap: 'wrap',
        }}
      >
        <StatusDot status={data.rollupStatus} size={14} />
        <strong style={{ fontSize: '1rem' }}>Certs: {STATUS_LABELS[data.rollupStatus]}</strong>
        <span style={{ color: '#94a3b8' }}>
          {greens} OK · {reds} problem · {total} probes
        </span>
        <span style={{ marginLeft: 'auto', color: '#64748b', fontSize: '0.75rem' }}>
          Last cycle: {timeAgo(data.probedAt)} · auto-refresh {formatInterval(data.intervalMs)}
        </span>
      </div>

      {refreshError && (
        <div style={{ color: STATUS_COLORS.red, marginBottom: '0.75rem' }}>
          Refresh error: {refreshError}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {grouped.map(g => (
          <div
            key={g.fqdn}
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.625rem 0.875rem',
                borderBottom: '1px solid #334155',
                background: '#172033',
              }}
            >
              <StatusDot status={g.groupStatus} size={12} />
              <strong style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{g.fqdn}</strong>
              <span style={{ color: '#64748b', fontSize: '0.75rem' }}>
                :{g.port} · pipeline {g.pipeline}
              </span>
              <button
                onClick={() => refreshFqdn(g.fqdn)}
                disabled={refreshingFqdn !== null}
                style={{
                  marginLeft: 'auto',
                  background: refreshingFqdn === g.fqdn ? '#1e3a5f' : '#334155',
                  color: '#e2e8f0',
                  border: '1px solid #475569',
                  borderRadius: '0.25rem',
                  padding: '0.25rem 0.625rem',
                  fontSize: '0.75rem',
                  cursor: refreshingFqdn !== null ? 'not-allowed' : 'pointer',
                  opacity: refreshingFqdn !== null && refreshingFqdn !== g.fqdn ? 0.5 : 1,
                }}
              >
                {refreshingFqdn === g.fqdn ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#0f172a', color: '#94a3b8', fontSize: '0.75rem', textAlign: 'left' }}>
                  <th style={{ padding: '0.5rem 0.875rem', fontWeight: 500 }}></th>
                  <th style={{ padding: '0.5rem 0.875rem', fontWeight: 500 }}>Provider</th>
                  <th style={{ padding: '0.5rem 0.875rem', fontWeight: 500 }}>IP</th>
                  <th style={{ padding: '0.5rem 0.875rem', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '0.5rem 0.875rem', fontWeight: 500 }}>Expires</th>
                  <th style={{ padding: '0.5rem 0.875rem', fontWeight: 500 }}>Issuer</th>
                  <th style={{ padding: '0.5rem 0.875rem', fontWeight: 500 }}>Probed</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map(r => (
                  <tr key={`${r.fqdn}-${r.ip}`} style={{ borderTop: '1px solid #233047' }}>
                    <td style={{ padding: '0.5rem 0.875rem' }}>
                      <StatusDot status={r.status} />
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem', color: '#cbd5e1' }}>{r.provider}</td>
                    <td style={{ padding: '0.5rem 0.875rem', fontFamily: 'ui-monospace, Menlo, monospace', color: '#cbd5e1' }}>
                      {r.ip || r.peerIp || (r.resolvedFromDns ? '(dns)' : '—')}
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem', color: STATUS_COLORS[r.status] }}>
                      {r.reason}
                      {r.consecutiveFailures > 0 && (
                        <span style={{ color: '#94a3b8', fontWeight: 400, marginLeft: '0.5rem' }}>
                          (failure streak: {r.consecutiveFailures})
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem', color: '#cbd5e1' }}>
                      {r.notAfter
                        ? `${new Date(r.notAfter).toISOString().slice(0, 10)} (${r.daysUntilExpiry}d)`
                        : '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem', color: '#94a3b8', fontSize: '0.75rem' }}>
                      {r.issuer ?? '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem', color: '#64748b', fontSize: '0.75rem' }}>
                      {timeAgo(r.probedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
