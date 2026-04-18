/**
 * gRPC Service Stats Page
 * Shows usage and performance metrics with time-series visualization
 */

import { useEffect, useRef, useState } from 'react';
import { createLazyFileRoute } from '@tanstack/react-router';
import { TextRoute } from '../../components/ui/text-route';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { Card } from '../../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { trpc } from '../../lib/trpc';
import { mockAuth } from '../../lib/config';
import { padTimeSeries } from '../../lib/stats-time-series';
import { toast } from 'sonner';
import { useServicesStatus } from '../../hooks/useServicesStatus';
import { liveRefetchInterval } from '../../hooks/liveRefetchInterval';
import { ServiceStatusIndicator } from '../../components/ui/service-status-indicator';
import {
  ComposedChart,
  BarChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
  Bar,
} from 'recharts';
import {
  BarChart3,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Ban,
  Loader2,
  Info,
  ChevronDown,
} from 'lucide-react';

export const Route = createLazyFileRoute('/services/grpc/stats')({
  component: GrpcStatsPage,
});

type TimeRange = '24h' | '7d' | '30d';

const TIME_RANGE_CONFIG = {
  '24h': { label: 'Last 24 Hours', bucketLabel: 'Hour' },
  '7d': { label: 'Last 7 Days', bucketLabel: 'Day' },
  '30d': { label: 'Last 30 Days', bucketLabel: 'Day' },
} as const;

// padTimeSeries / expectedBuckets live in lib/stats-time-series so both the
// gRPC and Seal stats pages share the same bucket-padding behaviour.

// Format date for display in UTC based on time range
function formatBucketLabel(isoDate: string, range: TimeRange): string {
  const date = new Date(isoDate);
  if (range === '24h') {
    // Show UTC date + hour (e.g., "Nov 29 20:00") for clarity across midnight
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    const timeStr = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });
    return `${dateStr} ${timeStr}`;
  }
  // Show UTC date (e.g., "Nov 29")
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// Format tick label - show date at midnight, time only at other hours (for 24h view)
function formatTickLabel(isoDate: string, range: TimeRange): string {
  const date = new Date(isoDate);
  if (range === '24h') {
    const hours = date.getUTCHours();
    if (hours === 0) {
      // Midnight - show date (e.g., "Dec 1")
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
    }
    // Other hours - show time only (e.g., "04:00")
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });
  }
  // 7d/30d views - show date
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// Check if a timestamp is at midnight (00:00 UTC)
function isMidnight(isoDate: string): boolean {
  const date = new Date(isoDate);
  return date.getUTCHours() === 0;
}

// Traffic data point type
interface TrafficDataPoint {
  bucket: string;
  guaranteed: number;
  burst: number;
  dropped: number;
  clientError: number;
  serverError: number;
  partial?: boolean;
}

// Traffic category config for stacked chart
const TRAFFIC_CATEGORIES = [
  { key: 'guaranteed', label: 'Guaranteed', color: 'bg-green-500 dark:bg-green-600', description: 'Successfully served guaranteed traffic' },
  { key: 'burst', label: 'Burst', color: 'bg-blue-500 dark:bg-blue-600', description: 'Successfully served burst traffic' },
  { key: 'dropped', label: 'Rejected', color: 'bg-yellow-500 dark:bg-yellow-600', description: 'Blocked at the edge — rate limit, IP block, API key issue, or service disabled' },
  { key: 'clientError', label: 'Invalid Request', color: 'bg-orange-500 dark:bg-orange-600', description: 'Reached the backend but failed validation (malformed payload, unknown endpoint, etc.)' },
  { key: 'serverError', label: 'Server Error', color: 'bg-red-500 dark:bg-red-600', description: 'Backend responded with a 5xx — typically a transient issue on our side' },
] as const;

// Area colors for SVG fill (matching Tailwind classes)
const AREA_COLORS = {
  guaranteed: { light: '#22c55e', dark: '#16a34a' },  // green-500/600
  burst: { light: '#3b82f6', dark: '#2563eb' },       // blue-500/600
  dropped: { light: '#eab308', dark: '#ca8a04' },     // yellow-500/600
  clientError: { light: '#f97316', dark: '#ea580c' }, // orange-500/600
  serverError: { light: '#ef4444', dark: '#dc2626' }, // red-500/600
};

// Traffic tooltip shared content (used by the recharts Tooltip's `content` prop)
function TrafficTooltip({
  active,
  payload,
  label,
  range,
  formatValue,
}: any) {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0].payload as TrafficDataPoint;
  const total = data.guaranteed + data.burst + data.dropped + data.clientError + data.serverError;
  return (
    <div className="bg-gray-900 dark:bg-gray-700 text-white text-xs px-3 py-2 rounded shadow-lg whitespace-nowrap">
      <div className="font-medium mb-1">
        {formatBucketLabel(label, range)}
        {data.partial && <span className="ml-1 text-gray-400 italic">(partial)</span>}
      </div>
      {TRAFFIC_CATEGORIES.map(cat => {
        const value = data[cat.key as keyof TrafficDataPoint] as number;
        if (value === 0) return null;
        return (
          <div key={cat.key} className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-sm ${cat.color}`} />
            <span>{cat.label}: {formatValue(value)}</span>
          </div>
        );
      })}
      <div className="border-t border-gray-600 mt-1 pt-1 font-medium">
        Total: {formatValue(total)}
      </div>
    </div>
  );
}

// Stacked bar chart for traffic breakdown. Uses recharts so axis/margin
// geometry matches the sibling response-time and bandwidth charts exactly.
function StackedAreaChart({
  data,
  range,
  formatValue,
  emptyMessage = 'No data',
}: {
  data: TrafficDataPoint[];
  range: TimeRange;
  formatValue: (v: number) => string;
  emptyMessage?: string;
}) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400">
        {emptyMessage}
      </div>
    );
  }

  const tickInterval = range === '24h' ? 3 : Math.max(1, Math.floor(data.length / 7));

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 20, right: 20, left: 10, bottom: 10 }}>
          <XAxis
            dataKey="bucket"
            tick={{ fontSize: 11, fill: '#9ca3af' }}
            tickFormatter={(v) => formatTickLabel(v, range)}
            axisLine={{ stroke: '#374151' }}
            tickLine={{ stroke: '#374151' }}
            interval={tickInterval}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#9ca3af' }}
            tickFormatter={(v) => formatValue(v)}
            axisLine={{ stroke: '#374151' }}
            tickLine={{ stroke: '#374151' }}
            width={60}
          />
          <Tooltip
            content={<TrafficTooltip range={range} formatValue={formatValue} />}
            cursor={{ fill: 'rgba(255,255,255,0.06)' }}
          />
          {TRAFFIC_CATEGORIES.map(cat => (
            <Bar
              key={cat.key}
              dataKey={cat.key}
              stackId="traffic"
              fill={AREA_COLORS[cat.key as keyof typeof AREA_COLORS]?.light ?? '#6b7280'}
              isAnimationActive={false}
            >
              {data.map((entry, i) => (
                <Cell
                  key={`${cat.key}-${i}`}
                  fillOpacity={entry.partial ? 0.45 : 0.85}
                />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Traffic legend with info tooltips
function TrafficLegend() {
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap gap-4 mt-4">
      {TRAFFIC_CATEGORIES.map(cat => (
        <div
          key={cat.key}
          className="flex items-center gap-2 relative"
          onMouseEnter={() => setHoveredCategory(cat.key)}
          onMouseLeave={() => setHoveredCategory(null)}
        >
          <div className={`w-3 h-3 rounded-sm ${cat.color}`} />
          <span className="text-sm text-gray-600 dark:text-gray-400">{cat.label}</span>
          <Info className="h-3 w-3 text-gray-400 cursor-help" />
          {/* Info tooltip */}
          {hoveredCategory === cat.key && (
            <div className="absolute bottom-full left-0 mb-2 z-20">
              <div className="bg-gray-900 dark:bg-gray-700 text-white text-xs px-3 py-2 rounded shadow-lg whitespace-nowrap max-w-xs">
                {cat.description}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Response time data point type (whisker chart)
interface ResponseTimeDataPoint {
  bucket: string;
  avgResponseTimeMs: number;
  minResponseTimeMs: number;
  maxResponseTimeMs: number;
}

// Response time whisker chart with Recharts
const THRESHOLD_MS = 1000; // 1 second threshold

// Custom whisker shape for the bar chart (includes average marker)
const WhiskerShape = (props: any) => {
  const { x, y, width, height, payload } = props;
  if (!payload) return null;

  const centerX = x + width / 2;
  const whiskerWidth = Math.min(width * 0.6, 12);
  const isAboveThreshold = payload.maxResponseTimeMs >= THRESHOLD_MS;
  const isPartial = payload.partial === true;
  const strokeColor = isAboveThreshold ? '#ef4444' : '#8b5cf6';
  const opacity = isPartial ? 0.4 : 1;

  // Calculate average marker position
  // The bar goes from base (min) to base+range (max)
  // y is the TOP of the bar (max value position), y+height is the BOTTOM (min value position)
  // We need to find where avg falls in this range
  const minY = y + height; // Bottom of bar (min value)
  const range = payload.maxResponseTimeMs - payload.minResponseTimeMs;
  const avgOffset = range > 0
    ? ((payload.avgResponseTimeMs - payload.minResponseTimeMs) / range) * height
    : height / 2;
  const avgY = minY - avgOffset; // Y coordinate for average

  return (
    <g opacity={opacity}>
      {/* Vertical line (whisker stem) */}
      <line
        x1={centerX}
        y1={y}
        x2={centerX}
        y2={y + height}
        stroke={strokeColor}
        strokeWidth={2}
        strokeDasharray={isPartial ? '4 2' : undefined}
      />
      {/* Top cap (max) */}
      <line
        x1={centerX - whiskerWidth / 2}
        y1={y}
        x2={centerX + whiskerWidth / 2}
        y2={y}
        stroke={strokeColor}
        strokeWidth={2}
      />
      {/* Bottom cap (min) */}
      <line
        x1={centerX - whiskerWidth / 2}
        y1={y + height}
        x2={centerX + whiskerWidth / 2}
        y2={y + height}
        stroke={strokeColor}
        strokeWidth={2}
      />
      {/* Average marker (diamond) */}
      <polygon
        points={`${centerX},${avgY - 5} ${centerX + 5},${avgY} ${centerX},${avgY + 5} ${centerX - 5},${avgY}`}
        fill={strokeColor}
        stroke="white"
        strokeWidth={1.5}
      />
    </g>
  );
};

// Custom tooltip for whisker chart
const WhiskerTooltip = ({ active, payload, label, formatValue, range }: any) => {
  if (!active || !payload || !payload[0]) return null;

  const data = payload[0].payload;
  const isAboveThreshold = data.maxResponseTimeMs >= THRESHOLD_MS;

  return (
    <div className={`text-white text-xs px-3 py-2 rounded shadow-lg ${
      isAboveThreshold ? 'bg-red-600' : 'bg-gray-900 dark:bg-gray-700'
    }`}>
      <div className="font-medium mb-1">
        {formatBucketLabel(data.bucket, range)}
        {data.partial && <span className="ml-1 text-gray-400 italic">(partial)</span>}
      </div>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-3">
          <span className="text-gray-300">Max:</span>
          <span className="font-medium">{formatValue(data.maxResponseTimeMs)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-gray-300">Avg:</span>
          <span className="font-bold">{formatValue(data.avgResponseTimeMs)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-gray-300">Min:</span>
          <span className="font-medium">{formatValue(data.minResponseTimeMs)}</span>
        </div>
      </div>
      {isAboveThreshold && (
        <div className="mt-1 pt-1 border-t border-red-400 text-yellow-200 text-[10px]">
          Exceeds 1s threshold
        </div>
      )}
    </div>
  );
};

function ResponseTimeChart({
  data,
  range,
  formatValue,
  emptyMessage = 'No data',
}: {
  data: ResponseTimeDataPoint[];
  range: TimeRange;
  formatValue: (v: number) => string;
  emptyMessage?: string;
}) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400">
        {emptyMessage}
      </div>
    );
  }

  // Transform data for whisker chart - need range for the bar
  const chartData = data.map((d, index) => ({
    ...d,
    index,
    // Bar will span from min to max
    range: d.maxResponseTimeMs - d.minResponseTimeMs,
    // For stacking: bar starts at min
    base: d.minResponseTimeMs,
  }));

  // Calculate max for Y axis
  const dataMax = Math.max(...data.map(d => d.maxResponseTimeMs));
  const yMax = dataMax >= THRESHOLD_MS
    ? Math.max(dataMax * 1.1, THRESHOLD_MS * 1.2)
    : Math.max(dataMax * 1.3, 100);

  // Calculate period average
  // Average over buckets that actually had traffic — empty (zero) buckets are
  // padding, not real data, and would otherwise drag the average down.
  const avgPoints = data.filter(d => d.avgResponseTimeMs > 0);
  const avgResponseTime = avgPoints.length > 0
    ? avgPoints.reduce((sum, d) => sum + d.avgResponseTimeMs, 0) / avgPoints.length
    : 0;

  // Check if any max exceeds threshold
  const hasExceededThreshold = data.some(d => d.maxResponseTimeMs >= THRESHOLD_MS);

  // Custom tick formatter for X axis
  const tickFormatter = (value: string) => formatTickLabel(value, range);

  // Determine tick interval
  const tickInterval = range === '24h' ? 3 : Math.max(1, Math.floor(data.length / 7));

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 20, right: 20, bottom: 10, left: 10 }}>
          {/* Y Axis */}
          <YAxis
            domain={[0, yMax]}
            tickFormatter={(v) => formatValue(v)}
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            axisLine={{ stroke: '#374151' }}
            tickLine={{ stroke: '#374151' }}
            width={60}
          />

          {/* X Axis — horizontal labels to match the custom StackedAreaChart and bandwidth chart */}
          <XAxis
            dataKey="bucket"
            tickFormatter={tickFormatter}
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            axisLine={{ stroke: '#374151' }}
            tickLine={{ stroke: '#374151' }}
            interval={tickInterval}
          />

          {/* Threshold reference line - only show if data approaches it */}
          {dataMax >= THRESHOLD_MS * 0.5 && (
            <ReferenceLine
              y={THRESHOLD_MS}
              stroke="#ef4444"
              strokeDasharray="6 4"
              strokeWidth={1.5}
              label={{
                value: '1s threshold',
                position: 'right',
                fill: '#ef4444',
                fontSize: 10,
              }}
            />
          )}

          {/* Average reference line */}
          <ReferenceLine
            y={avgResponseTime}
            stroke="#10b981"
            strokeDasharray="4 3"
            strokeWidth={1.5}
            label={{
              value: `avg ${formatValue(avgResponseTime)}`,
              position: 'left',
              fill: '#10b981',
              fontSize: 10,
            }}
          />

          {/* Custom tooltip */}
          <Tooltip
            content={<WhiskerTooltip formatValue={formatValue} range={range} />}
            cursor={{ fill: 'rgba(255,255,255,0.1)' }}
          />

          {/* Whisker bars - using stacked bars for base + range */}
          {/* Invisible base bar */}
          <Bar dataKey="base" stackId="whisker" fill="transparent" />
          {/* Range bar with custom shape */}
          <Bar
            dataKey="range"
            stackId="whisker"
            shape={<WhiskerShape />}
            isAnimationActive={false}
          >
            {chartData.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.maxResponseTimeMs >= THRESHOLD_MS ? '#ef4444' : '#8b5cf6'}
              />
            ))}
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6 mt-2 text-xs text-gray-500">
        <div className="flex items-center gap-1.5">
          <svg width="16" height="16" viewBox="0 0 16 16">
            <line x1="8" y1="2" x2="8" y2="14" stroke="#8b5cf6" strokeWidth="2" />
            <line x1="4" y1="2" x2="12" y2="2" stroke="#8b5cf6" strokeWidth="2" />
            <line x1="4" y1="14" x2="12" y2="14" stroke="#8b5cf6" strokeWidth="2" />
          </svg>
          <span>Min-Max range</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg width="16" height="16" viewBox="0 0 16 16">
            <polygon points="8,3 13,8 8,13 3,8" fill="#8b5cf6" stroke="white" strokeWidth="1" />
          </svg>
          <span>Average</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-0.5 bg-emerald-500" style={{ background: 'repeating-linear-gradient(90deg, #10b981, #10b981 4px, transparent 4px, transparent 7px)' }} />
          <span>Period avg</span>
        </div>
      </div>
    </div>
  );
}

// Summary stat card
function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  color: 'green' | 'yellow' | 'orange' | 'red' | 'blue';
}) {
  const colorClasses = {
    green: 'text-green-500',
    yellow: 'text-yellow-500',
    orange: 'text-orange-500',
    red: 'text-red-500',
    blue: 'text-blue-500',
  };

  return (
    <div className="flex items-center gap-3 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
      <Icon className={`h-5 w-5 ${colorClasses[color]}`} />
      <div>
        <div className="text-lg font-semibold text-gray-900 dark:text-gray-50">{value}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      </div>
    </div>
  );
}

function GrpcStatsPage() {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [testMenuOpen, setTestMenuOpen] = useState(false);
  // Off-switch so the dev can observe the real polling UX (wait up to
  // 60s for organic refresh) instead of the dev-ergonomics forceSync.
  const [autoSync, setAutoSync] = useState(true);

  const utils = trpc.useUtils();

  // Pending auto-sync timers — cleared on unmount so a navigation during
  // the 16s window doesn't leave stray mutations in flight.
  const autoSyncTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { autoSyncTimers.current.forEach(clearTimeout); }, []);

  // Fetch service to check enabled state (for onboarding check)
  const { data: services } = trpc.services.list.useQuery();
  const grpcService = services?.find(s => s.serviceType === 'grpc');
  const isEnabled = grpcService?.isUserEnabled ?? false;

  // Unified status tracking with adaptive polling
  const { getServiceStatus } = useServicesStatus();
  const grpcStatus = getServiceStatus('grpc');
  const isSyncing = grpcStatus?.syncStatus === 'pending';

  // Live polling: 60s → 10m backoff after 1h of no change;
  // auto-refresh on tab focus.
  const liveOpts = { refetchInterval: liveRefetchInterval, refetchOnWindowFocus: true } as const;

  // Fetch summary stats (matches selected time range, hybrid real-time)
  const { data: summary, isLoading: summaryLoading } = trpc.stats.getSummary.useQuery({
    serviceType: 'grpc',
    range: timeRange,
  }, liveOpts);

  // Fetch traffic breakdown over time (for stacked chart)
  const { data: trafficData, isLoading: trafficLoading } = trpc.stats.getTraffic.useQuery({
    serviceType: 'grpc',
    range: timeRange,
  }, liveOpts);

  // Fetch response time over time
  const { data: rtData, isLoading: rtLoading } = trpc.stats.getResponseTime.useQuery({
    serviceType: 'grpc',
    range: timeRange,
  }, liveOpts);

  // Fetch bandwidth over time
  const { data: bwData, isLoading: bwLoading } = trpc.stats.getBandwidth.useQuery({
    serviceType: 'grpc',
    range: timeRange,
  }, liveOpts);

  const invalidateAll = () => {
    utils.stats.getSummary.invalidate();
    utils.stats.getTraffic.invalidate();
    utils.stats.getResponseTime.invalidate();
    utils.stats.getBandwidth.invalidate();
    // Usage-This-Month on the overview page reads from billing — keep it
    // in lockstep with the stats charts.
    utils.billing.getNextScheduledPayment.invalidate();
  };

  // Inject test data mutation (random distribution)
  const injectTestData = trpc.stats.injectTestData.useMutation({
    onSuccess: () => {
      invalidateAll();
      toast.success('Test data injected');
    },
    onError: () => toast.error('Failed to inject test data'),
  });

  // Inject demo data mutation (nice 24h pattern)
  const injectDemoData = trpc.stats.injectDemoData.useMutation({
    onSuccess: () => {
      invalidateAll();
      toast.success('Demo data injected');
    },
    onError: () => toast.error('Failed to inject demo data'),
  });

  // Clear stats mutation
  const clearStats = trpc.stats.clearStats.useMutation({
    onSuccess: () => {
      invalidateAll();
      toast.success('Stats cleared');
    },
    onError: () => toast.error('Failed to clear stats'),
  });

  // Force sync: refresh stats aggregate + sync usage to DRAFT invoice.
  // Toast is owned by each call site so manual vs auto-triggered runs
  // can be told apart in the UI.
  const forceSyncStats = trpc.stats.forceSyncStats.useMutation({
    onSuccess: () => {
      invalidateAll();
    },
    onError: (err) => toast.error(`Sync failed: ${err.message}`),
  });

  // Real traffic: gRPC requests/streaming through HAProxy metered port with real API key
  const generateRealTraffic = trpc.grpc.generateRealTraffic.useMutation({
    onSuccess: (data) => {
      invalidateAll();
      if (data.mode === 'requests') {
        toast.success(`Real traffic: ${data.successCount}/${data.requests} requests, ${(data.totalBytes / 1024).toFixed(0)}KB`);
      } else {
        toast.success(`Real traffic: ${data.checkpoints} checkpoints, ${(data.bytes / 1024).toFixed(0)}KB in ${data.durationMs / 1000}s`);
      }
      // Two forceSyncs at 8s + 16s cover typical + worst-case fluentd
      // flush timing. Timers tracked so they cancel on unmount.
      if (autoSync) {
        const autoSyncToast = { onSuccess: () => toast.success('Auto Force Sync Done') };
        autoSyncTimers.current.push(
          setTimeout(() => forceSyncStats.mutate(undefined, autoSyncToast), 8_000),
          setTimeout(() => forceSyncStats.mutate(undefined, autoSyncToast), 16_000),
        );
      }
    },
    onError: (err) => toast.error(`Real traffic failed: ${err.message}`),
  });

  const isLoading = injectTestData.isPending || injectDemoData.isPending || clearStats.isPending || generateRealTraffic.isPending || forceSyncStats.isPending;

  const formatNumber = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  const formatMs = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
    return `${n.toFixed(0)}ms`;
  };

  const handleTestAction = (action: string) => {
    setTestMenuOpen(false);
    switch (action) {
      case 'inject1h':
        // Quick test data (1 hour, random distribution, no whisker spread)
        injectTestData.mutate({ serviceType: 'grpc', hoursOfData: 1, requestsPerHour: 100 });
        break;
      case 'clear':
        clearStats.mutate({ serviceType: 'grpc' });
        break;
      case 'injectDemo':
        // Full 24h demo with realistic patterns and whisker spread
        injectDemoData.mutate({ serviceType: 'grpc' });
        break;
      case 'realRequests10':
        generateRealTraffic.mutate({ mode: 'requests', count: 10 });
        break;
      case 'realRequests50':
        generateRealTraffic.mutate({ mode: 'requests', count: 50 });
        break;
      case 'realStream3s':
        generateRealTraffic.mutate({ mode: 'stream', durationSecs: 3 });
        break;
      case 'realStream10s':
        generateRealTraffic.mutate({ mode: 'stream', durationSecs: 10 });
        break;
      case 'forceSyncStats':
        forceSyncStats.mutate(undefined, {
          onSuccess: () => toast.success('Force Sync Done'),
        });
        break;
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="pb-6 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">gRPC Statistics</h1>
            {mockAuth && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setTestMenuOpen(!testMenuOpen)}
                  disabled={isLoading}
                  className="inline-flex items-center justify-center gap-0.5 px-1.5 h-5 text-xs font-mono border border-gray-300 dark:border-gray-600 rounded bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors disabled:opacity-50"
                  title="Test data menu"
                >
                  {isLoading ? '...' : 'T'}
                  <ChevronDown className="h-3 w-3" />
                </button>
                {testMenuOpen && (
                  <>
                    {/* Backdrop to close menu */}
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setTestMenuOpen(false)}
                    />
                    {/* Dropdown menu */}
                    <div className="absolute left-0 top-full mt-1 z-20 w-36 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg py-1">
                      <button
                        type="button"
                        onClick={() => handleTestAction('inject1h')}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Inject 1H (random)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTestAction('injectDemo')}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Inject Demo (24H)
                      </button>
                      <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                      <button
                        type="button"
                        onClick={() => handleTestAction('realRequests10')}
                        className="w-full text-left px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        10 Requests
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTestAction('realRequests50')}
                        className="w-full text-left px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        50 Requests
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTestAction('realStream3s')}
                        className="w-full text-left px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Stream 3s
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTestAction('realStream10s')}
                        className="w-full text-left px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Stream 10s
                      </button>
                      <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                      <button
                        type="button"
                        onClick={() => handleTestAction('forceSyncStats')}
                        className="w-full text-left px-3 py-1.5 text-xs text-green-600 dark:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Force Sync Stats
                      </button>
                      <label
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-green-600 dark:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={autoSync}
                          onChange={(e) => setAutoSync(e.target.checked)}
                          className="h-3 w-3"
                        />
                        Auto Force Sync
                      </label>
                      <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                      <button
                        type="button"
                        onClick={() => handleTestAction('clear')}
                        className="w-full text-left px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Clear All
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          {/* Status indicator - uses shared component for consistency */}
          {grpcService && (
            <div data-testid="service-status" className="mt-1">
              <ServiceStatusIndicator
                operationalStatus={grpcStatus?.operationalStatus}
                isSyncing={isSyncing}
                fallbackIsEnabled={isEnabled}
                showLabel
              />
            </div>
          )}
        </div>

        {/* Config Needed Banner - warn when service can't operate due to missing config */}
        {grpcStatus?.operationalStatus === 'config_needed' && grpcStatus.configNeededReason && (
          <div data-testid="config-needed-banner" className="rounded-lg border border-yellow-200 dark:border-yellow-900 bg-yellow-50 dark:bg-yellow-900/20 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
                  Configuration Required
                </p>
                <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                  {grpcStatus.configNeededReason}. <TextRoute to="/services/grpc/overview" search={{ tab: 'x-api-key' }}>Go to API Key tab</TextRoute>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Time Range Tabs */}
        <Tabs value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
          <TabsList>
            <TabsTrigger value="24h">Last 24 Hours</TabsTrigger>
            <TabsTrigger value="7d">Last 7 Days</TabsTrigger>
            <TabsTrigger value="30d">Last 30 Days</TabsTrigger>
          </TabsList>

          {/* Summary Stats */}
          <div className="mt-6">
            <Card className="p-6">
              {summaryLoading ? (
                <div className="flex items-center justify-center h-20">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <StatCard
                    icon={BarChart3}
                    label="Total Requests"
                    value={formatNumber(summary?.totalRequests ?? 0)}
                    color="blue"
                  />
                  <StatCard
                    icon={CheckCircle2}
                    label="Successful (2xx)"
                    value={(() => {
                      const success = summary?.successCount ?? 0;
                      const total = summary?.totalRequests ?? 0;
                      if (total === 0) return '0';
                      const rate = (success / total) * 100;
                      const rateStr = rate > 99 ? '>99' : Math.round(rate).toString();
                      return `${formatNumber(success)} (${rateStr}%)`;
                    })()}
                    color="green"
                  />
                  <StatCard
                    icon={Ban}
                    label="Rejected"
                    value={formatNumber(summary?.droppedCount ?? 0)}
                    color="yellow"
                  />
                  <StatCard
                    icon={AlertTriangle}
                    label="Invalid Request (4xx)"
                    value={formatNumber(summary?.clientErrorCount ?? 0)}
                    color="orange"
                  />
                  <StatCard
                    icon={XCircle}
                    label="Server Error (5xx)"
                    value={formatNumber(summary?.serverErrorCount ?? 0)}
                    color="red"
                  />
                </div>
              )}
            </Card>
          </div>

          {/* Charts - shared across all tabs */}
          <div className="mt-6 space-y-6">
            {/* Traffic Breakdown Over Time */}
            <Card className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="h-5 w-5 text-blue-500" />
                <h2 className="text-lg font-medium text-gray-900 dark:text-gray-50">
                  Traffic per {TIME_RANGE_CONFIG[timeRange].bucketLabel.toLowerCase()}
                </h2>
              </div>
              {trafficLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              ) : (
                <StackedAreaChart
                  data={padTimeSeries(trafficData, timeRange, (b) => ({
                    bucket: b, guaranteed: 0, burst: 0, dropped: 0, clientError: 0, serverError: 0, partial: false,
                  }))}
                  range={timeRange}
                  formatValue={formatNumber}
                  emptyMessage="Stats may take up to 2 minutes to appear"
                />
              )}
              {/* Legend */}
              <TrafficLegend />
            </Card>

            {/* Response Time Over Time */}
            <Card className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <Clock className="h-5 w-5 text-purple-500" />
                <h2 className="text-lg font-medium text-gray-900 dark:text-gray-50">
                  Response Time (average per {TIME_RANGE_CONFIG[timeRange].bucketLabel.toLowerCase()})
                </h2>
              </div>
              {rtLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              ) : (
                <ResponseTimeChart
                  data={padTimeSeries(rtData, timeRange, (b) => ({
                    bucket: b, avgResponseTimeMs: 0, minResponseTimeMs: 0, maxResponseTimeMs: 0, partial: false,
                  }))}
                  range={timeRange}
                  formatValue={formatMs}
                  emptyMessage="Stats may take up to 2 minutes to appear"
                />
              )}
            </Card>

            {/* Bandwidth Over Time */}
            <Card className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="h-5 w-5 text-emerald-500" />
                <h2 className="text-lg font-medium text-gray-900 dark:text-gray-50">
                  Bandwidth (per {TIME_RANGE_CONFIG[timeRange].bucketLabel.toLowerCase()})
                </h2>
              </div>
              {bwLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              ) : (() => {
                const paddedBw = padTimeSeries(bwData, timeRange, (b) => ({ bucket: b, bytes: 0, partial: false }));
                return (
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={paddedBw} margin={{ top: 20, right: 20, left: 10, bottom: 10 }}>
                    <XAxis
                      dataKey="bucket"
                      tick={{ fontSize: 11, fill: '#9ca3af' }}
                      tickFormatter={(v) => formatTickLabel(v, timeRange)}
                      interval={timeRange === '24h' ? 3 : Math.max(1, Math.floor(paddedBw.length / 7))}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#9ca3af' }}
                      tickFormatter={(v) => {
                        if (v >= 1073741824) return `${(v / 1073741824).toFixed(1)} GB`;
                        if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
                        if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
                        return `${v} B`;
                      }}
                      width={60}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                      labelStyle={{ color: '#94a3b8' }}
                      labelFormatter={(v: string) => {
                        const point = paddedBw.find(d => d.bucket === v);
                        const suffix = point?.partial ? ' (partial)' : '';
                        return formatBucketLabel(v, timeRange) + suffix;
                      }}
                      formatter={(value: number) => {
                        if (value >= 1073741824) return [`${(value / 1073741824).toFixed(3)} GB`, 'Bandwidth'];
                        if (value >= 1048576) return [`${(value / 1048576).toFixed(2)} MB`, 'Bandwidth'];
                        if (value >= 1024) return [`${(value / 1024).toFixed(1)} KB`, 'Bandwidth'];
                        return [`${value} bytes`, 'Bandwidth'];
                      }}
                    />
                    <Bar dataKey="bytes" fill="#10b981" radius={[2, 2, 0, 0]}>
                      {paddedBw.map((entry, index) => (
                        <Cell
                          key={`bw-${index}`}
                          fill={entry.partial ? '#10b981' : '#10b981'}
                          opacity={entry.partial ? 0.45 : 1}
                          strokeDasharray={entry.partial ? '4 2' : undefined}
                          stroke={entry.partial ? '#6ee7b7' : undefined}
                          strokeWidth={entry.partial ? 1.5 : 0}
                        />
                      ))}
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
                );
              })()}
            </Card>
          </div>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
