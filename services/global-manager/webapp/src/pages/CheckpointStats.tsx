import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAdminPollingContext } from '../contexts/AdminPollingContext';

interface StatsRow {
  location: string;
  process: number;
  upstream: string | null;
  latestDelayMs: number;
  avg1mMs: number;
  min1mMs: number;
  max1mMs: number;
  latestCursor: number;
  totalCheckpoints: number;
  firstCount: number;
  droppedCount: number;
  deltaBestMs: number;
}

type SortKey = 'location' | 'latestDelayMs' | 'avg1mMs' | 'min1mMs' | 'max1mMs' | 'deltaBestMs';
type SortDir = 'asc' | 'desc';

export function CheckpointStats() {
  const [rows, setRows] = useState<StatsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('location');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [serviceStatus, setServiceStatus] = useState<Record<number, boolean>>({});
  const [serviceLoading, setServiceLoading] = useState<number | null>(null);
  const { pollingInterval, markUpdated } = useAdminPollingContext();

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/checkpoint-stats');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.rows);
      setError(null);
      markUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [markUpdated]);

  const fetchServiceStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/checkpoint-stats/service-status');
      if (res.ok) {
        const data = await res.json();
        setServiceStatus(data.services ?? {});
      }
    } catch { /* dev-only, ignore */ }
  }, []);

  const toggleService = useCallback(async (process: number) => {
    const running = serviceStatus[process];
    setServiceLoading(process);
    try {
      await fetch('/api/checkpoint-stats/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ process, action: running ? 'stop' : 'start' }),
      });
      await fetchServiceStatus();
    } catch { /* ignore */ }
    setServiceLoading(null);
  }, [serviceStatus, fetchServiceStatus]);

  useEffect(() => {
    fetchStats();
    fetchServiceStatus();
    const interval = setInterval(() => { fetchStats(); fetchServiceStatus(); }, Math.max(pollingInterval, 6000));
    return () => clearInterval(interval);
  }, [fetchStats, fetchServiceStatus, pollingInterval]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortedRows = useMemo(() =>
    [...rows].sort((a, b) => {
      let cmp: number;
      if (sortKey === 'location') {
        cmp = a.location.localeCompare(b.location);
      } else {
        cmp = (a[sortKey] as number) - (b[sortKey] as number);
      }
      return sortDir === 'desc' ? -cmp : cmp;
    }),
    [rows, sortKey, sortDir],
  );

  const SortHeader = ({ label, field, width }: { label: string; field: SortKey; width?: string }) => (
    <th
      onClick={() => toggleSort(field)}
      style={{
        padding: '0.5rem 0.75rem',
        textAlign: 'left',
        fontSize: '0.75rem',
        fontWeight: 600,
        color: '#94a3b8',
        cursor: 'pointer',
        userSelect: 'none',
        width,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      {sortKey === field && (
        <span style={{ marginLeft: '0.25rem', fontSize: '0.625rem' }}>
          {sortDir === 'asc' ? '\u25B2' : '\u25BC'}
        </span>
      )}
    </th>
  );

  const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', fontVariantNumeric: 'tabular-nums', color: '#e2e8f0' };
  const dimCellStyle: React.CSSProperties = { ...cellStyle, fontSize: '0.75rem', color: '#64748b' };

  const fmtDelay = (ms: number) => {
    if (ms === 0) return '-';
    return `${ms}`;
  };

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#e2e8f0', margin: 0 }}>
          Checkpoint Streaming Stats
        </h2>
        <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0.25rem 0 0' }}>
          Per sui-proxy checkpoint delivery delay. Mainnet only. Auto-refreshes every 6s.
        </p>
      </div>

      {/* Service controls (dev only — stops sui-proxy to avoid abusing free endpoints) */}
      {Object.keys(serviceStatus).length > 0 && (
        <div style={{
          display: 'flex',
          gap: '0.75rem',
          marginBottom: '1rem',
          alignItems: 'center',
        }}>
          {[1, 2].map((proc) => {
            const running = serviceStatus[proc];
            const loading = serviceLoading === proc;
            return (
              <button
                key={proc}
                onClick={() => toggleService(proc)}
                disabled={loading}
                style={{
                  padding: '0.375rem 0.75rem',
                  borderRadius: '0.375rem',
                  border: '1px solid #475569',
                  background: running ? '#1e3a5f' : '#1e293b',
                  color: running ? '#4ade80' : '#94a3b8',
                  fontSize: '0.8125rem',
                  cursor: loading ? 'wait' : 'pointer',
                  opacity: loading ? 0.5 : 1,
                }}
              >
                {loading ? '...' : running ? '\u25A0' : '\u25B6'} mgrpc{proc}
              </button>
            );
          })}
          <span style={{ fontSize: '0.7rem', color: '#475569' }}>
            dev only — stop to conserve Mysten Labs free endpoints
          </span>
        </div>
      )}

      {loading && <p style={{ color: '#94a3b8' }}>Loading...</p>}
      {error && <p style={{ color: '#f87171' }}>Error: {error}</p>}

      {sortedRows.length > 0 && (
        <div style={{
          background: '#1e293b',
          borderRadius: '0.5rem',
          border: '1px solid #334155',
          overflow: 'auto',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              {/* Row 1: "Realtime Offset" group label with border box */}
              <tr>
                <th style={{ borderBottom: 'none' }} />
                <th colSpan={4} style={{
                  padding: '0.4rem 0.75rem',
                  textAlign: 'center',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: '#60a5fa',
                  letterSpacing: '0.05em',
                  borderLeft: '2px solid #60a5fa',
                  borderRight: '2px solid #60a5fa',
                  borderTop: '2px solid #60a5fa',
                  borderBottom: 'none',
                }}>
                  Realtime Offset (ms)
                </th>
                <th style={{ borderBottom: 'none' }} />
                <th style={{ borderBottom: 'none' }} />
                <th style={{ borderBottom: 'none' }} />
              </tr>
              {/* Row 2: all column headers, offset columns get side borders */}
              <tr style={{ borderBottom: '1px solid #334155' }}>
                <SortHeader label="Location" field="location" width="220px" />
                <th onClick={() => toggleSort('latestDelayMs')} style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', cursor: 'pointer', userSelect: 'none', borderLeft: '2px solid #60a5fa', whiteSpace: 'nowrap' }}>
                  Latest{sortKey === 'latestDelayMs' && <span style={{ marginLeft: '0.25rem', fontSize: '0.625rem' }}>{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>}
                </th>
                <SortHeader label="1m Worst" field="min1mMs" />
                <SortHeader label="1m Best" field="max1mMs" />
                <th onClick={() => toggleSort('avg1mMs')} style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', cursor: 'pointer', userSelect: 'none', borderRight: '2px solid #60a5fa', whiteSpace: 'nowrap' }}>
                  1m Avg{sortKey === 'avg1mMs' && <span style={{ marginLeft: '0.25rem', fontSize: '0.625rem' }}>{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>}
                </th>
                <SortHeader label={'\u0394 Best'} field="deltaBestMs" />
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8' }}>Cursor</th>
                <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8' }}>Win / Drop</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const isOutput = row.upstream === null;
                return (
                  <tr
                    key={row.location}
                    style={{
                      borderBottom: '1px solid #334155',
                      background: isOutput ? '#1e3a5f' : 'transparent',
                      fontWeight: isOutput ? 600 : 400,
                    }}
                  >
                    <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', fontSize: '0.75rem', color: '#e2e8f0' }}>
                      {row.location}
                    </td>
                    <td style={cellStyle}>
                      {fmtDelay(row.latestDelayMs)}
                    </td>
                    <td style={cellStyle}>
                      {fmtDelay(row.min1mMs)}
                    </td>
                    <td style={cellStyle}>
                      {fmtDelay(row.max1mMs)}
                    </td>
                    <td style={cellStyle}>
                      {fmtDelay(row.avg1mMs)}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', fontVariantNumeric: 'tabular-nums' }}>
                      {row.avg1mMs !== 0 ? (
                        <span style={{ color: row.deltaBestMs === 0 ? '#4ade80' : '#e2e8f0', fontWeight: row.deltaBestMs === 0 ? 700 : 400 }}>
                          {row.deltaBestMs}
                        </span>
                      ) : (
                        <span style={{ color: '#475569' }}>-</span>
                      )}
                    </td>
                    <td style={dimCellStyle}>
                      {row.latestCursor > 0 ? row.latestCursor.toLocaleString() : '-'}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', fontVariantNumeric: 'tabular-nums', fontSize: '0.75rem' }}>
                      {isOutput ? (
                        <span style={{ color: '#64748b' }}>output</span>
                      ) : (
                        <>
                          <span style={{ color: '#4ade80' }}>{row.firstCount}</span>
                          {' / '}
                          <span style={{ color: '#fb923c' }}>{row.droppedCount}</span>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && sortedRows.length === 0 && (
        <p style={{ color: '#64748b' }}>No checkpoint stats available. Are sui-proxy instances running?</p>
      )}
    </div>
  );
}
