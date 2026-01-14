import { useState, useEffect, useCallback } from 'react';
import { useAdminPollingContext } from '../contexts/AdminPollingContext';

type TimeRange = '24h' | '7d' | '2y';

// Server status: Green (healthy), Yellow (degraded), Red (errors)
type ServerStatus = 'green' | 'yellow' | 'red' | 'gray';

interface RangeSummary {
  total: number;
  serverErrors: number;  // Backend + Infrastructure (user-affecting)
  clientErrors: number;  // Auth + IP + Authz (client's fault)
  avgTotalMs: number | null;
}

interface ServiceSummary {
  name: string;
  ranges: Record<string, RangeSummary>;
}

interface SummaryResponse {
  services: Record<string, ServiceSummary>;
}

interface Bucket {
  bucket: string;
  total: number;
  serverErrors: number;
  clientErrors: number;
  avgTotalMs: number | null;
}

interface ServiceBuckets {
  name: string;
  buckets: Bucket[];
}

interface StatusBarResponse {
  services: Record<string, ServiceBuckets>;
  granularity: 'hour' | 'day' | 'week';
}

interface ErrorType {
  code: number;
  name: string;
  count: number;
}

interface ErrorCategory {
  name: string;
  range: [number, number];
  total: number;
  types: ErrorType[];
}

interface ServiceErrors {
  name: string;
  categories: ErrorCategory[];
}

interface ErrorsResponse {
  services: Record<string, ServiceErrors>;
}

interface GraphBucket {
  bucket: string;
  requests: number;
  avgTotalMs: number | null;
  avgQueueMs: number | null;
  avgConnectMs: number | null;
  avgRtMs: number | null;
}

interface ServiceGraphs {
  name: string;
  buckets: GraphBucket[];
}

interface GraphsResponse {
  services: Record<string, ServiceGraphs>;
  granularity: 'hour' | 'day' | 'week';
}

// Server status colors
const SERVER_STATUS_COLORS: Record<ServerStatus, string> = {
  green: '#4ade80',   // Healthy - no errors, fast responses
  yellow: '#fbbf24',  // Degraded - slow responses (>150ms)
  red: '#ef4444',     // Errors - server errors affecting users
  gray: '#374151',    // No data
};

// Client status colors (blue-purple gradient for monitoring)
const CLIENT_STATUS_COLORS = {
  none: '#374151',     // No data or no client errors
  low: '#6366f1',      // Some client errors
  medium: '#8b5cf6',   // Moderate client errors
  high: '#a855f7',     // High client errors
};

// Determine server status from bucket data
const getServerStatus = (bucket: Bucket): ServerStatus => {
  if (bucket.total === 0) return 'gray';
  if (bucket.serverErrors > 0) return 'red';
  if (bucket.avgTotalMs !== null && bucket.avgTotalMs > 150) return 'yellow';
  return 'green';
};

// Determine client status color from bucket data
const getClientStatusColor = (bucket: Bucket): string => {
  if (bucket.total === 0) return CLIENT_STATUS_COLORS.none;
  if (bucket.clientErrors === 0) return CLIENT_STATUS_COLORS.none;
  const errorRate = bucket.clientErrors / bucket.total;
  if (errorRate > 0.1) return CLIENT_STATUS_COLORS.high;    // > 10%
  if (errorRate > 0.01) return CLIENT_STATUS_COLORS.medium; // > 1%
  return CLIENT_STATUS_COLORS.low;
};

const getServerStatusLabel = (status: ServerStatus): string => {
  switch (status) {
    case 'green': return 'Healthy';
    case 'yellow': return 'Degraded';
    case 'red': return 'Errors';
    case 'gray': return 'No data';
  }
};

// Format large numbers
const formatNumber = (n: number): string => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
};

// Format bucket time for tooltip
const formatBucketTime = (bucket: string, granularity: 'hour' | 'day' | 'week'): string => {
  const date = new Date(bucket);
  if (granularity === 'hour') {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } else if (granularity === 'day') {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } else {
    return `Week of ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
};

// Simple SVG Bar Chart for Request Volume
function RequestGraph({ buckets, granularity }: { buckets: GraphBucket[]; granularity: 'hour' | 'day' | 'week' }) {
  const width = 400;
  const height = 120;
  const padding = { top: 10, right: 10, bottom: 20, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxRequests = Math.max(...buckets.map(b => b.requests), 1);
  const barWidth = Math.max(2, (chartWidth / buckets.length) - 1);

  const yTicks = [0, Math.round(maxRequests / 2), maxRequests];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {yTicks.map((tick, i) => (
        <text
          key={i}
          x={padding.left - 5}
          y={padding.top + chartHeight - (tick / maxRequests) * chartHeight}
          textAnchor="end"
          fontSize="9"
          fill="#64748b"
        >
          {formatNumber(tick)}
        </text>
      ))}
      {buckets.map((b, i) => {
        const barHeight = (b.requests / maxRequests) * chartHeight;
        const x = padding.left + i * (chartWidth / buckets.length);
        const y = padding.top + chartHeight - barHeight;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            fill="#3b82f6"
            rx={1}
          >
            <title>{`${formatBucketTime(b.bucket, granularity)}: ${formatNumber(b.requests)} requests`}</title>
          </rect>
        );
      })}
      <line
        x1={padding.left}
        y1={padding.top + chartHeight}
        x2={width - padding.right}
        y2={padding.top + chartHeight}
        stroke="#334155"
        strokeWidth={1}
      />
    </svg>
  );
}

// Simple SVG Line Chart for Latency
function LatencyGraph({ buckets }: { buckets: GraphBucket[]; granularity: 'hour' | 'day' | 'week' }) {
  const width = 400;
  const height = 120;
  const padding = { top: 10, right: 10, bottom: 20, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const allLatencies = buckets.flatMap(b => [b.avgTotalMs, b.avgRtMs].filter((v): v is number => v !== null));
  const maxLatency = Math.max(...allLatencies, 1);

  const generatePath = (getValue: (b: GraphBucket) => number | null): string => {
    const points: string[] = [];
    buckets.forEach((b, i) => {
      const value = getValue(b);
      if (value !== null) {
        const x = padding.left + (i / (buckets.length - 1 || 1)) * chartWidth;
        const y = padding.top + chartHeight - (value / maxLatency) * chartHeight;
        points.push(`${points.length === 0 ? 'M' : 'L'}${x},${y}`);
      }
    });
    return points.join(' ');
  };

  const yTicks = [0, Math.round(maxLatency / 2), Math.round(maxLatency)];

  const metrics = [
    { key: 'total', getValue: (b: GraphBucket) => b.avgTotalMs, color: '#f97316', label: 'Total' },
    { key: 'rt', getValue: (b: GraphBucket) => b.avgRtMs, color: '#22c55e', label: 'Backend' },
  ];

  // Add 150ms threshold line if it's visible
  const threshold150 = 150;
  const show150Line = threshold150 < maxLatency;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
        {yTicks.map((tick, i) => (
          <text
            key={i}
            x={padding.left - 5}
            y={padding.top + chartHeight - (tick / maxLatency) * chartHeight}
            textAnchor="end"
            fontSize="9"
            fill="#64748b"
          >
            {tick}
          </text>
        ))}
        {yTicks.slice(1).map((tick, i) => (
          <line
            key={i}
            x1={padding.left}
            y1={padding.top + chartHeight - (tick / maxLatency) * chartHeight}
            x2={width - padding.right}
            y2={padding.top + chartHeight - (tick / maxLatency) * chartHeight}
            stroke="#334155"
            strokeWidth={0.5}
            strokeDasharray="2,2"
          />
        ))}
        {/* 150ms threshold line */}
        {show150Line && (
          <line
            x1={padding.left}
            y1={padding.top + chartHeight - (threshold150 / maxLatency) * chartHeight}
            x2={width - padding.right}
            y2={padding.top + chartHeight - (threshold150 / maxLatency) * chartHeight}
            stroke="#fbbf24"
            strokeWidth={1}
            strokeDasharray="4,2"
          />
        )}
        {metrics.map(m => (
          <path
            key={m.key}
            d={generatePath(m.getValue)}
            fill="none"
            stroke={m.color}
            strokeWidth={1.5}
          />
        ))}
        <line
          x1={padding.left}
          y1={padding.top + chartHeight}
          x2={width - padding.right}
          y2={padding.top + chartHeight}
          stroke="#334155"
          strokeWidth={1}
        />
      </svg>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '0.7rem' }}>
        {metrics.map(m => (
          <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ width: '12px', height: '2px', background: m.color }} />
            <span style={{ color: '#94a3b8' }}>{m.label}</span>
          </div>
        ))}
        {show150Line && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ width: '12px', height: '2px', background: '#fbbf24', borderStyle: 'dashed' }} />
            <span style={{ color: '#94a3b8' }}>150ms threshold</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Service Section Component
function ServiceSection({
  serviceId,
  serviceName,
  selectedRange,
  summary,
  statusBar,
  graphs,
  errors,
  granularity,
  expandedCategories,
  toggleCategory,
}: {
  serviceId: string;
  serviceName: string;
  selectedRange: TimeRange;
  summary: RangeSummary | undefined;
  statusBar: Bucket[] | undefined;
  graphs: GraphBucket[] | undefined;
  errors: ErrorCategory[] | undefined;
  granularity: 'hour' | 'day' | 'week';
  expandedCategories: Set<string>;
  toggleCategory: (key: string) => void;
}) {
  const [hoveredBucket, setHoveredBucket] = useState<{ bucket: Bucket; type: 'server' | 'client' } | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const handleBucketHover = (bucket: Bucket | null, type: 'server' | 'client', event?: React.MouseEvent) => {
    if (bucket && event) {
      setHoveredBucket({ bucket, type });
      setTooltipPos({ x: event.clientX, y: event.clientY });
    } else {
      setHoveredBucket(null);
      setTooltipPos(null);
    }
  };

  const hasData = summary && summary.total > 0;

  // Determine overall server status for header
  const getOverallServerStatus = (): ServerStatus => {
    if (!summary || summary.total === 0) return 'gray';
    if (summary.serverErrors > 0) return 'red';
    if (summary.avgTotalMs !== null && summary.avgTotalMs > 150) return 'yellow';
    return 'green';
  };

  const overallStatus = getOverallServerStatus();

  return (
    <div style={{
      background: '#1e293b',
      borderRadius: '0.5rem',
      padding: '1rem',
      marginBottom: '1.5rem',
      border: `1px solid ${hasData ? SERVER_STATUS_COLORS[overallStatus] : '#334155'}`,
    }}>
      {/* Service Header with Summary */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1rem',
        paddingBottom: '0.75rem',
        borderBottom: '1px solid #334155',
      }}>
        <h3 style={{ color: '#e2e8f0', fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
          {serviceName}
        </h3>
        {summary && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
            {/* Server Status */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: SERVER_STATUS_COLORS[overallStatus],
              }} />
              <span style={{ color: '#e2e8f0', fontSize: '0.875rem', fontWeight: 500 }}>
                {getServerStatusLabel(overallStatus)}
              </span>
            </div>
            {/* Stats */}
            <div style={{ color: '#64748b', fontSize: '0.75rem', textAlign: 'right' }}>
              <div>{formatNumber(summary.total)} requests</div>
              {summary.serverErrors > 0 && (
                <div style={{ color: '#f87171' }}>{formatNumber(summary.serverErrors)} server errors</div>
              )}
              {summary.clientErrors > 0 && (
                <div style={{ color: '#a78bfa' }}>{formatNumber(summary.clientErrors)} client errors</div>
              )}
              {summary.avgTotalMs !== null && (
                <div style={{ color: summary.avgTotalMs > 150 ? '#fbbf24' : '#94a3b8' }}>
                  {Math.round(summary.avgTotalMs)}ms avg
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {!hasData ? (
        <div style={{ color: '#64748b', fontSize: '0.875rem', textAlign: 'center', padding: '2rem' }}>
          No data available for {serviceName}
        </div>
      ) : (
        <>
          {/* Status Bars */}
          {statusBar && statusBar.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              {/* Server Status Bar */}
              <div style={{ marginBottom: '0.75rem' }}>
                <h4 style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                  Server Status ({selectedRange === '24h' ? 'Hourly' : selectedRange === '7d' ? 'Daily' : 'Weekly'})
                </h4>
                <div style={{
                  display: 'flex',
                  gap: '2px',
                  alignItems: 'flex-end',
                  minHeight: '28px',
                }}>
                  {statusBar.map((b, i) => {
                    const status = getServerStatus(b);
                    return (
                      <div
                        key={i}
                        style={{
                          width: selectedRange === '2y' ? '6px' : selectedRange === '7d' ? '40px' : '16px',
                          height: '24px',
                          backgroundColor: SERVER_STATUS_COLORS[status],
                          borderRadius: '2px',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => handleBucketHover(b, 'server', e)}
                        onMouseLeave={() => handleBucketHover(null, 'server')}
                        onMouseMove={(e) => {
                          if (hoveredBucket?.bucket === b) {
                            setTooltipPos({ x: e.clientX, y: e.clientY });
                          }
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Client Status Bar */}
              <div>
                <h4 style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                  Client Errors (Auth/IP/Access)
                </h4>
                <div style={{
                  display: 'flex',
                  gap: '2px',
                  alignItems: 'flex-end',
                  minHeight: '28px',
                }}>
                  {statusBar.map((b, i) => (
                    <div
                      key={i}
                      style={{
                        width: selectedRange === '2y' ? '6px' : selectedRange === '7d' ? '40px' : '16px',
                        height: '24px',
                        backgroundColor: getClientStatusColor(b),
                        borderRadius: '2px',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => handleBucketHover(b, 'client', e)}
                      onMouseLeave={() => handleBucketHover(null, 'client')}
                      onMouseMove={(e) => {
                        if (hoveredBucket?.bucket === b) {
                          setTooltipPos({ x: e.clientX, y: e.clientY });
                        }
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Graphs */}
          {graphs && graphs.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '1rem',
              marginBottom: '1rem',
            }}>
              <div style={{
                background: '#0f172a',
                padding: '0.75rem',
                borderRadius: '0.375rem',
              }}>
                <h4 style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                  Request Volume
                </h4>
                <RequestGraph buckets={graphs} granularity={granularity} />
              </div>
              <div style={{
                background: '#0f172a',
                padding: '0.75rem',
                borderRadius: '0.375rem',
              }}>
                <h4 style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                  Response Latency (ms)
                </h4>
                <LatencyGraph buckets={graphs} granularity={granularity} />
              </div>
            </div>
          )}

          {/* Error Breakdown */}
          {errors && errors.length > 0 && (
            <div>
              <h4 style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                Error Breakdown
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {errors.map(cat => {
                  const categoryKey = `${serviceId}-${cat.name}`;
                  // Color code: server errors (red), client errors (purple)
                  const isServerError = cat.name === 'Backend' || cat.name === 'Infrastructure';
                  const errorColor = isServerError ? '#f87171' : '#a78bfa';
                  return (
                    <div key={cat.name}>
                      <div
                        onClick={() => toggleCategory(categoryKey)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '0.375rem 0.5rem',
                          background: '#0f172a',
                          borderRadius: '0.25rem',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ color: '#64748b', fontSize: '0.7rem' }}>
                            {expandedCategories.has(categoryKey) ? '▼' : '▶'}
                          </span>
                          <span style={{ color: '#e2e8f0', fontSize: '0.8rem' }}>
                            {cat.name} ({cat.range[0]}-{cat.range[1]})
                          </span>
                          <span style={{
                            fontSize: '0.65rem',
                            padding: '0.125rem 0.375rem',
                            borderRadius: '0.25rem',
                            background: isServerError ? 'rgba(248, 113, 113, 0.2)' : 'rgba(167, 139, 250, 0.2)',
                            color: errorColor,
                          }}>
                            {isServerError ? 'Server' : 'Client'}
                          </span>
                        </div>
                        <span style={{ color: errorColor, fontSize: '0.8rem', fontWeight: 'bold' }}>
                          {formatNumber(cat.total)}
                        </span>
                      </div>
                      {expandedCategories.has(categoryKey) && (
                        <div style={{
                          marginLeft: '1.25rem',
                          marginTop: '0.125rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.125rem',
                        }}>
                          {cat.types.map(type => (
                            <div
                              key={type.code}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '0.25rem 0.5rem',
                                background: isServerError ? 'rgba(248, 113, 113, 0.1)' : 'rgba(167, 139, 250, 0.1)',
                                borderRadius: '0.25rem',
                                borderLeft: `3px solid ${errorColor}`,
                              }}
                            >
                              <div>
                                <span style={{ color: '#94a3b8', fontSize: '0.7rem', marginRight: '0.5rem' }}>
                                  ({type.code})
                                </span>
                                <span style={{ color: '#e2e8f0', fontSize: '0.8rem' }}>
                                  {type.name}
                                </span>
                              </div>
                              <span style={{ color: errorColor, fontSize: '0.8rem' }}>
                                {formatNumber(type.count)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Tooltip */}
      {hoveredBucket && tooltipPos && (
        <div style={{
          position: 'fixed',
          left: tooltipPos.x + 10,
          top: tooltipPos.y - 10,
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: '0.375rem',
          padding: '0.75rem',
          zIndex: 1000,
          minWidth: '200px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.3)',
          pointerEvents: 'none',
        }}>
          <div style={{ color: '#e2e8f0', fontWeight: 'bold', marginBottom: '0.5rem' }}>
            {formatBucketTime(hoveredBucket.bucket.bucket, granularity)}
          </div>
          <div style={{ borderTop: '1px solid #334155', paddingTop: '0.5rem' }}>
            <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
              Total: {formatNumber(hoveredBucket.bucket.total)} requests
            </div>
            {hoveredBucket.type === 'server' ? (
              <>
                <div style={{ color: '#f87171', fontSize: '0.75rem' }}>
                  Server errors: {formatNumber(hoveredBucket.bucket.serverErrors)}
                </div>
                {hoveredBucket.bucket.avgTotalMs !== null && (
                  <div style={{
                    color: hoveredBucket.bucket.avgTotalMs > 150 ? '#fbbf24' : '#4ade80',
                    fontSize: '0.75rem'
                  }}>
                    Avg latency: {Math.round(hoveredBucket.bucket.avgTotalMs)}ms
                    {hoveredBucket.bucket.avgTotalMs > 150 && ' (degraded)'}
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: '#a78bfa', fontSize: '0.75rem' }}>
                Client errors: {formatNumber(hoveredBucket.bucket.clientErrors)}
                {hoveredBucket.bucket.total > 0 && (
                  <span style={{ color: '#64748b' }}>
                    {' '}({((hoveredBucket.bucket.clientErrors / hoveredBucket.bucket.total) * 100).toFixed(2)}%)
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{
            borderTop: '1px solid #334155',
            paddingTop: '0.5rem',
            marginTop: '0.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}>
            {hoveredBucket.type === 'server' ? (
              <>
                <span style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '2px',
                  background: SERVER_STATUS_COLORS[getServerStatus(hoveredBucket.bucket)],
                }} />
                <span style={{ color: '#e2e8f0', fontSize: '0.75rem' }}>
                  {getServerStatusLabel(getServerStatus(hoveredBucket.bucket))}
                </span>
              </>
            ) : (
              <>
                <span style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '2px',
                  background: getClientStatusColor(hoveredBucket.bucket),
                }} />
                <span style={{ color: '#e2e8f0', fontSize: '0.75rem' }}>
                  {hoveredBucket.bucket.clientErrors === 0 ? 'No client errors' :
                   hoveredBucket.bucket.clientErrors > hoveredBucket.bucket.total * 0.1 ? 'High activity' :
                   hoveredBucket.bucket.clientErrors > hoveredBucket.bucket.total * 0.01 ? 'Moderate activity' :
                   'Low activity'}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function InfraStats() {
  const [selectedRange, setSelectedRange] = useState<TimeRange>('24h');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [statusBar, setStatusBar] = useState<StatusBarResponse | null>(null);
  const [errors, setErrors] = useState<ErrorsResponse | null>(null);
  const [graphs, setGraphs] = useState<GraphsResponse | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { pollingInterval, markUpdated } = useAdminPollingContext();

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/infra/summary');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSummary(data);
    } catch (e) {
      console.error('Failed to fetch summary:', e);
    }
  }, []);

  const fetchStatusBar = useCallback(async () => {
    try {
      const res = await fetch(`/api/infra/status-bar?range=${selectedRange}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatusBar(data);
    } catch (e) {
      console.error('Failed to fetch status bar:', e);
    }
  }, [selectedRange]);

  const fetchErrors = useCallback(async () => {
    try {
      const res = await fetch(`/api/infra/errors?range=${selectedRange}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setErrors(data);
    } catch (e) {
      console.error('Failed to fetch errors:', e);
    }
  }, [selectedRange]);

  const fetchGraphs = useCallback(async () => {
    try {
      const res = await fetch(`/api/infra/graphs?range=${selectedRange}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setGraphs(data);
    } catch (e) {
      console.error('Failed to fetch graphs:', e);
    }
  }, [selectedRange]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        await Promise.all([fetchSummary(), fetchStatusBar(), fetchErrors(), fetchGraphs()]);
        markUpdated();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [fetchSummary, fetchStatusBar, fetchErrors, fetchGraphs, markUpdated]);

  useEffect(() => {
    fetchStatusBar();
    fetchErrors();
    fetchGraphs();
  }, [selectedRange, fetchStatusBar, fetchErrors, fetchGraphs]);

  useEffect(() => {
    const interval = setInterval(async () => {
      await Promise.all([fetchSummary(), fetchStatusBar(), fetchErrors(), fetchGraphs()]);
      markUpdated();
    }, pollingInterval);
    return () => clearInterval(interval);
  }, [pollingInterval, fetchSummary, fetchStatusBar, fetchErrors, fetchGraphs, markUpdated]);

  const toggleCategory = (key: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (loading && !summary) {
    return (
      <div style={{ color: '#94a3b8', padding: '2rem' }}>
        Loading infrastructure stats...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ color: '#f87171', padding: '2rem' }}>
        Error: {error}
      </div>
    );
  }

  const serviceIds = ['1', '2', '3'];
  const granularity = statusBar?.granularity || graphs?.granularity || 'hour';

  return (
    <div style={{ maxWidth: '1000px' }}>
      {/* Time Range Selector */}
      <div style={{
        display: 'flex',
        gap: '0.5rem',
        marginBottom: '1.5rem',
      }}>
        {(['24h', '7d', '2y'] as TimeRange[]).map(range => (
          <button
            key={range}
            onClick={() => setSelectedRange(range)}
            style={{
              padding: '0.5rem 1rem',
              background: selectedRange === range ? '#3b82f6' : '#1e293b',
              color: selectedRange === range ? 'white' : '#94a3b8',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: selectedRange === range ? 600 : 400,
            }}
          >
            {range === '24h' ? '24 Hours' : range === '7d' ? '7 Days' : '2 Years'}
          </button>
        ))}
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '1rem',
        marginBottom: '1rem',
        fontSize: '0.75rem',
        color: '#64748b',
      }}>
        <div style={{ fontWeight: 600, color: '#94a3b8' }}>Server Status:</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: '12px', height: '12px', background: SERVER_STATUS_COLORS.green, borderRadius: '2px' }} />
          Healthy
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: '12px', height: '12px', background: SERVER_STATUS_COLORS.yellow, borderRadius: '2px' }} />
          Degraded (&gt;150ms)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: '12px', height: '12px', background: SERVER_STATUS_COLORS.red, borderRadius: '2px' }} />
          Errors
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: '12px', height: '12px', background: SERVER_STATUS_COLORS.gray, borderRadius: '2px' }} />
          No data
        </div>
      </div>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '1rem',
        marginBottom: '1.5rem',
        fontSize: '0.75rem',
        color: '#64748b',
      }}>
        <div style={{ fontWeight: 600, color: '#94a3b8' }}>Client Errors:</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: '12px', height: '12px', background: CLIENT_STATUS_COLORS.none, borderRadius: '2px' }} />
          None
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: '12px', height: '12px', background: CLIENT_STATUS_COLORS.low, borderRadius: '2px' }} />
          Low
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: '12px', height: '12px', background: CLIENT_STATUS_COLORS.medium, borderRadius: '2px' }} />
          Moderate
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: '12px', height: '12px', background: CLIENT_STATUS_COLORS.high, borderRadius: '2px' }} />
          High
        </div>
      </div>

      {/* Service Sections */}
      {serviceIds.map(serviceId => {
        const serviceSummary = summary?.services[serviceId];
        const serviceStatusBar = statusBar?.services[serviceId];
        const serviceGraphs = graphs?.services[serviceId];
        const serviceErrors = errors?.services[serviceId];

        return (
          <ServiceSection
            key={serviceId}
            serviceId={serviceId}
            serviceName={serviceSummary?.name || `Service ${serviceId}`}
            selectedRange={selectedRange}
            summary={serviceSummary?.ranges[selectedRange]}
            statusBar={serviceStatusBar?.buckets}
            graphs={serviceGraphs?.buckets}
            errors={serviceErrors?.categories}
            granularity={granularity}
            expandedCategories={expandedCategories}
            toggleCategory={toggleCategory}
          />
        );
      })}
    </div>
  );
}
