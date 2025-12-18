import { useState, useEffect, useCallback } from 'react';
import { useAdminPollingContext } from '../contexts/AdminPollingContext';
import { SyncIndicator, SyncState } from '../components/SyncIndicator';

interface VaultVersion {
  seq: number;
  pg: number;
  filename: string;
}

interface VaultInfo {
  vaultType: string;
  latest: VaultVersion | null;
  previous: VaultVersion | null;
  allVersions: VaultVersion[];
}

interface LMVaultStatus {
  type: string;
  appliedSeq: number;
  processingSeq: number | null;
  customerCount: number;
  error?: string;
}

interface LMStatus {
  name: string;
  host: string;
  reachable: boolean;
  vaults: LMVaultStatus[];
  error?: string;
  rawData?: any;
}

interface GMVaultStatus {
  vaults: Record<string, VaultInfo>;
  error?: string;
}

function VaultVersionRow({ version, isLatest, isPrevious }: { version: VaultVersion; isLatest?: boolean; isPrevious?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '1rem',
      padding: '0.5rem 0.75rem',
      background: isLatest ? '#1e3a5f' : isPrevious ? '#1e293b' : '#0f172a',
      borderRadius: '0.25rem',
      borderLeft: isLatest ? '3px solid #4ade80' : isPrevious ? '3px solid #fbbf24' : '3px solid transparent',
    }}>
      <span style={{
        fontFamily: 'monospace',
        color: '#e2e8f0',
        minWidth: '60px',
      }}>
        seq={version.seq}
      </span>
      <span style={{
        fontFamily: 'monospace',
        color: '#94a3b8',
        minWidth: '50px',
      }}>
        pg={version.pg}
      </span>
      <span style={{
        fontFamily: 'monospace',
        color: '#64748b',
        fontSize: '0.75rem',
        flex: 1,
      }}>
        {version.filename}
      </span>
      {isLatest && (
        <span style={{ color: '#4ade80', fontSize: '0.75rem', fontWeight: 600 }}>LATEST</span>
      )}
      {isPrevious && (
        <span style={{ color: '#fbbf24', fontSize: '0.75rem', fontWeight: 600 }}>PREVIOUS</span>
      )}
    </div>
  );
}

export function KVCryptDebug() {
  const [gmVaults, setGmVaults] = useState<GMVaultStatus | null>(null);
  const [lmStatuses, setLmStatuses] = useState<LMStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedLM, setExpandedLM] = useState<string | null>(null);

  // Adaptive polling based on user activity
  const { pollingInterval, markUpdated } = useAdminPollingContext();

  const fetchData = useCallback(async () => {
    try {
      // Fetch GM vault status
      const gmRes = await fetch('/api/vault/status');
      if (!gmRes.ok) throw new Error(`GM status: HTTP ${gmRes.status}`);
      const gmData = await gmRes.json();
      setGmVaults(gmData);

      // Fetch LM statuses
      const lmRes = await fetch('/api/lm/status');
      if (!lmRes.ok) throw new Error(`LM status: HTTP ${lmRes.status}`);
      const lmData = await lmRes.json();
      setLmStatuses(lmData.managers || []);

      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  const triggerSync = async () => {
    try {
      const res = await fetch('/api/queue/sync-all', { method: 'POST' });
      if (!res.ok) throw new Error(`Sync failed: HTTP ${res.status}`);
      // Refresh after sync
      setTimeout(fetchData, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    }
  };

  // Calculate LM sync state
  const getLMState = (lm: LMStatus, isLmBehind: boolean): SyncState => {
    if (!lm.reachable) return SyncState.Down;
    if (lm.error) return SyncState.Error;
    if (isLmBehind) return SyncState.Pending;
    // Synced if all vaults have applied >= 1 and no processing
    const allApplied = lm.vaults.every(v => v.appliedSeq > 0 && v.processingSeq === null);
    if (allApplied) return SyncState.Sync;
    return SyncState.Pending;
  };

  // Calculate vault sync state
  const getVaultState = (vault: LMVaultStatus, isBehind: boolean): SyncState => {
    if (vault.error) return SyncState.Error;
    if (isBehind) return SyncState.Pending;
    // Synced if applied >= 1 and not processing
    if (vault.appliedSeq > 0 && vault.processingSeq === null) return SyncState.Sync;
    return SyncState.Pending;
  };

  useEffect(() => {
    const fetchAndMark = async () => {
      await fetchData();
      markUpdated();
    };
    fetchAndMark();
    const interval = setInterval(fetchAndMark, pollingInterval);
    return () => clearInterval(interval);
  }, [fetchData, pollingInterval, markUpdated]);

  if (loading) {
    return (
      <div style={{ color: '#94a3b8', padding: '2rem' }}>
        Loading vault status...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1000px' }}>
      {/* Header with actions */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1.5rem',
      }}>
        <div>
          <h1 style={{ fontSize: '1.25rem', color: '#e2e8f0', margin: 0 }}>
            KVCrypt Vault Status
          </h1>
          <p style={{ fontSize: '0.875rem', color: '#64748b', margin: '0.25rem 0 0' }}>
            Monitor vault propagation between GM and LMs
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              background: '#334155',
              color: '#e2e8f0',
              border: 'none',
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              cursor: refreshing ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={triggerSync}
            style={{
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Trigger Sync-All
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          background: '#7f1d1d',
          color: '#fca5a5',
          padding: '0.75rem 1rem',
          borderRadius: '0.375rem',
          marginBottom: '1rem',
          fontSize: '0.875rem',
        }}>
          Error: {error}
        </div>
      )}

      {/* GM Vault Status (data_tx) */}
      <div style={{
        background: '#1e293b',
        borderRadius: '0.5rem',
        padding: '1rem',
        marginBottom: '1.5rem',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1rem',
          paddingBottom: '0.75rem',
          borderBottom: '1px solid #334155',
        }}>
          <h2 style={{ fontSize: '1rem', color: '#60a5fa', margin: 0 }}>
            Global Manager (data_tx)
          </h2>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            /opt/syncf/data_tx
          </span>
        </div>

        {gmVaults?.vaults && Object.keys(gmVaults.vaults).length > 0 ? (
          Object.entries(gmVaults.vaults).map(([vaultType, info]) => (
            <div key={vaultType} style={{ marginBottom: '1rem' }}>
              <h3 style={{
                fontSize: '0.875rem',
                color: '#94a3b8',
                margin: '0 0 0.5rem',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}>
                {vaultType} Vault
              </h3>

              {info.latest ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <VaultVersionRow version={info.latest} isLatest />
                  {info.previous && (
                    <VaultVersionRow version={info.previous} isPrevious />
                  )}

                  {/* Show more versions if available */}
                  {info.allVersions.length > 2 && (
                    <details style={{ marginTop: '0.5rem' }}>
                      <summary style={{
                        color: '#64748b',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        padding: '0.25rem 0',
                      }}>
                        Show {info.allVersions.length - 2} more version(s)
                      </summary>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.5rem' }}>
                        {info.allVersions.slice(2).map((v) => (
                          <VaultVersionRow key={v.filename} version={v} />
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              ) : (
                <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
                  No vault files found
                </p>
              )}
            </div>
          ))
        ) : (
          <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
            No vaults configured or accessible
          </p>
        )}
      </div>

      {/* Local Managers Status */}
      <div style={{
        background: '#1e293b',
        borderRadius: '0.5rem',
        padding: '1rem',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1rem',
          paddingBottom: '0.75rem',
          borderBottom: '1px solid #334155',
        }}>
          <h2 style={{ fontSize: '1rem', color: '#60a5fa', margin: 0 }}>
            Local Managers
          </h2>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            /opt/syncf/data (synced via sync-files)
          </span>
        </div>

        {lmStatuses.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {lmStatuses.map((lm) => (
              <div
                key={lm.name}
                style={{
                  background: '#0f172a',
                  borderRadius: '0.375rem',
                  padding: '0.75rem 1rem',
                  border: '1px solid #334155',
                }}
              >
                {/* Check if any vault is behind GM */}
                {(() => {
                  const isLmBehind = lm.reachable && lm.vaults.some((v) => {
                    const gmSeq = gmVaults?.vaults?.[v.type]?.latest?.seq;
                    return gmSeq !== undefined && v.appliedSeq < gmSeq;
                  });
                  return (
                    <>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: lm.vaults.length > 0 ? '0.5rem' : 0,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <span style={{ color: '#e2e8f0', fontWeight: 500 }}>{lm.name}</span>
                          <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{lm.host}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <SyncIndicator state={getLMState(lm, isLmBehind)} />
                          {lm.rawData && (
                            <button
                              onClick={() => setExpandedLM(expandedLM === lm.name ? null : lm.name)}
                              style={{
                                background: 'transparent',
                                border: '1px solid #475569',
                                color: '#94a3b8',
                                cursor: 'pointer',
                                padding: '0.25rem 0.5rem',
                                borderRadius: '0.25rem',
                                fontSize: '0.7rem',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem'
                              }}
                              title="Toggle JSON viewer"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                                <line x1="16" y1="13" x2="8" y2="13" />
                                <line x1="16" y1="17" x2="8" y2="17" />
                                <polyline points="10 9 9 9 8 9" />
                              </svg>
                              JSON
                            </button>
                          )}
                        </div>
                      </div>

                      {lm.reachable && lm.vaults.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          {lm.vaults.map((vault) => {
                            const gmSeq = gmVaults?.vaults?.[vault.type]?.latest?.seq;
                            const isBehind = gmSeq !== undefined && vault.appliedSeq < gmSeq;
                            return (
                              <div
                                key={vault.type}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '1rem',
                                  fontSize: '0.875rem',
                                }}
                              >
                                <span style={{ color: '#94a3b8' }}>
                                  <span style={{ fontFamily: 'monospace' }}>{vault.type.toUpperCase()}</span>
                                </span>
                                <span style={{ color: '#94a3b8' }}>
                                  applied=<span style={{ fontFamily: 'monospace' }}>{vault.appliedSeq}</span>
                                  {vault.processingSeq !== null && (
                                    <span style={{ color: '#60a5fa' }}> (processing: {vault.processingSeq})</span>
                                  )}
                                  {isBehind && (
                                    <span style={{ color: '#fbbf24' }}> (GM: {gmSeq})</span>
                                  )}
                                </span>
                                <span style={{ color: '#94a3b8' }}>
                                  customers=<span style={{ fontFamily: 'monospace' }}>{vault.customerCount}</span>
                                </span>
                                <SyncIndicator state={getVaultState(vault, isBehind)} />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  );
                })()}

                {lm.error && (
                  <p style={{ color: '#f87171', fontSize: '0.75rem', margin: '0.5rem 0 0' }}>
                    {lm.error}
                  </p>
                )}

                {/* JSON Accordion */}
                {expandedLM === lm.name && lm.rawData && (
                  <div style={{
                    marginTop: '0.75rem',
                    padding: '0.75rem',
                    background: '#020617',
                    borderRadius: '0.25rem',
                    border: '1px solid #334155'
                  }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.5rem'
                    }}>
                      <span style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 'bold' }}>
                        Raw LM Status
                      </span>
                    </div>
                    <pre style={{
                      color: '#94a3b8',
                      fontSize: '0.7rem',
                      margin: 0,
                      overflow: 'auto',
                      maxHeight: '400px',
                      background: '#0f172a',
                      padding: '0.75rem',
                      borderRadius: '0.25rem'
                    }}>
                      {JSON.stringify(lm.rawData, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
            No Local Managers configured
          </p>
        )}
      </div>

      {/* Legend */}
      <div style={{
        marginTop: '1.5rem',
        padding: '1rem',
        background: '#0f172a',
        borderRadius: '0.375rem',
        fontSize: '0.75rem',
        color: '#64748b',
      }}>
        <strong style={{ color: '#94a3b8' }}>Legend:</strong>
        <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem' }}>
          <span><span style={{ color: '#4ade80' }}>GREEN</span> = Latest/In Sync</span>
          <span><span style={{ color: '#fbbf24' }}>YELLOW</span> = Previous/Behind</span>
          <span><span style={{ color: '#f87171' }}>RED</span> = Error/Down</span>
        </div>
        <p style={{ margin: '0.5rem 0 0' }}>
          GM writes to data_tx, sync-files copies to data, LMs read from data.
        </p>
      </div>
    </div>
  );
}
