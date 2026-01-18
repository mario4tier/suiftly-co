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
  processingError: string | null;
  customerCount: number;
}

interface LMStatus {
  name: string;
  host: string;
  reachable: boolean;
  vaults: LMVaultStatus[];
  error?: string;
  rawData?: any;
}

interface LMStatusResponse {
  managers: LMStatus[];
}

interface GMVaultStatus {
  vaults: Record<string, VaultInfo>;
  error?: string;
}

// Vault type labels (short names for display)
// Note: Master seeds are stored in ~/.suiftly.env, not in vaults (see APP_SECURITY_DESIGN.md)
const VAULT_LABELS: Record<string, string> = {
  sma: 'SMA',  // Seal Mainnet API (HAProxy config)
  smk: 'SMK',  // Seal Mainnet Keyserver
  smo: 'SMO',  // Seal Mainnet Open
  sta: 'STA',  // Seal Testnet API (HAProxy config)
  stk: 'STK',  // Seal Testnet Keyserver
  sto: 'STO',  // Seal Testnet Open
  skk: 'SKK',  // Seal Test/Dev
};

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

      // Fetch LM statuses (LM reports all its expected vault types)
      const lmRes = await fetch('/api/lm/status');
      if (!lmRes.ok) throw new Error(`LM status: HTTP ${lmRes.status}`);
      const lmData: LMStatusResponse = await lmRes.json();
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
    if (vault.processingError) return SyncState.Error;
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
            Global Manager
          </h2>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            /opt/syncf/data_tx
          </span>
        </div>

        {gmVaults?.vaults && Object.keys(gmVaults.vaults).length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {Object.entries(gmVaults.vaults).map(([vaultType, info]) => (
              <div
                key={vaultType}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  fontSize: '0.875rem',
                }}
              >
                <span style={{ color: '#94a3b8', minWidth: '40px' }}>
                  <span style={{ fontFamily: 'monospace' }}>{VAULT_LABELS[vaultType] || vaultType.toUpperCase()}</span>
                </span>
                {info.latest ? (
                  <span style={{ color: '#94a3b8' }}>
                    seq=<span style={{ fontFamily: 'monospace', color: '#4ade80' }}>{info.latest.seq}</span>
                  </span>
                ) : (
                  <>
                    <span style={{ color: '#f87171', fontWeight: 500 }}>No vault files</span>
                    <SyncIndicator state={SyncState.Error} />
                  </>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: '#f87171', fontSize: '0.875rem', margin: 0 }}>
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

                      {lm.reachable && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          {/* Show all vault types that LM reports (LM knows its expected types) */}
                          {lm.vaults.map((lmVault) => {
                            const vaultType = lmVault.type;
                            const gmSeq = gmVaults?.vaults?.[vaultType]?.latest?.seq;
                            const gmHasVault = gmSeq !== undefined && gmSeq > 0;
                            const isBehind = gmHasVault && lmVault.appliedSeq < gmSeq;
                            const hasNoData = lmVault.appliedSeq === 0 && lmVault.processingSeq === null;
                            const hasError = lmVault.processingError !== null;

                            return (
                              <div
                                key={vaultType}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '1rem',
                                  fontSize: '0.875rem',
                                }}
                              >
                                <span style={{ color: '#94a3b8', minWidth: '40px' }}>
                                  <span style={{ fontFamily: 'monospace' }}>{VAULT_LABELS[vaultType] || vaultType.toUpperCase()}</span>
                                </span>
                                {hasError ? (
                                  <>
                                    <span style={{ color: '#f87171', fontWeight: 500 }}>
                                      error: {lmVault.processingError}
                                    </span>
                                    <SyncIndicator state={SyncState.Error} />
                                  </>
                                ) : hasNoData ? (
                                  <>
                                    <span style={{ color: '#f87171', fontWeight: 500 }}>
                                      not loaded
                                      {gmHasVault && <span> (GM: {gmSeq})</span>}
                                    </span>
                                    <SyncIndicator state={SyncState.Error} />
                                  </>
                                ) : (
                                  <>
                                    <span style={{ color: '#94a3b8' }}>
                                      applied=<span style={{ fontFamily: 'monospace' }}>{lmVault.appliedSeq}</span>
                                      {lmVault.processingSeq !== null && (
                                        <span style={{ color: '#60a5fa' }}> (processing: {lmVault.processingSeq})</span>
                                      )}
                                      {isBehind && (
                                        <span style={{ color: '#fbbf24' }}> (GM: {gmSeq})</span>
                                      )}
                                    </span>
                                    <span style={{ color: '#94a3b8' }}>
                                      customers=<span style={{ fontFamily: 'monospace' }}>{lmVault.customerCount}</span>
                                    </span>
                                    <SyncIndicator state={getVaultState(lmVault, isBehind)} />
                                  </>
                                )}
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
