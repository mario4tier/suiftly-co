/**
 * Seal Service Stats Page
 * Shows usage and performance metrics with time-series visualization
 */

import { useState } from 'react';
import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { Card } from '../../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { trpc } from '../../lib/trpc';
import { mockAuth } from '../../lib/config';
import { toast } from 'sonner';
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

export const Route = createLazyFileRoute('/services/seal/stats')({
  component: SealStatsPage,
});

type TimeRange = '24h' | '7d' | '30d';

const TIME_RANGE_CONFIG = {
  '24h': { label: 'Last 24 Hours', bucketLabel: 'Hour' },
  '7d': { label: 'Last 7 Days', bucketLabel: 'Day' },
  '30d': { label: 'Last 30 Days', bucketLabel: 'Day' },
} as const;

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

// Simple bar chart component
function SimpleBarChart({
  data,
  range,
  valueKey,
  formatValue,
  color = 'blue',
  emptyMessage = 'No data',
}: {
  data: Array<{ bucket: string; [key: string]: number | string }>;
  range: TimeRange;
  valueKey: string;
  formatValue: (v: number) => string;
  color?: 'blue' | 'green' | 'purple';
  emptyMessage?: string;
}) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400">
        {emptyMessage}
      </div>
    );
  }

  // Find max value for scaling
  const maxValue = Math.max(...data.map(d => Number(d[valueKey]) || 0), 1);

  const colorClasses = {
    blue: 'bg-blue-500 dark:bg-blue-600',
    green: 'bg-green-500 dark:bg-green-600',
    purple: 'bg-purple-500 dark:bg-purple-600',
  };

  return (
    <div className="h-48 flex items-end gap-1">
      {data.map((point, i) => {
        const value = Number(point[valueKey]) || 0;
        const height = (value / maxValue) * 100;
        return (
          <div
            key={i}
            className="flex-1 flex flex-col items-center justify-end group relative"
          >
            {/* Bar */}
            <div
              className={`w-full rounded-t transition-all ${colorClasses[color]} opacity-80 hover:opacity-100`}
              style={{ height: `${Math.max(height, 2)}%` }}
            />
            {/* Tooltip */}
            <div className="absolute bottom-full mb-2 hidden group-hover:block z-10">
              <div className="bg-gray-900 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded whitespace-nowrap">
                {formatBucketLabel(point.bucket, range)}: {formatValue(value)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Traffic data point type
interface TrafficDataPoint {
  bucket: string;
  guaranteed: number;
  burst: number;
  dropped: number;
  clientError: number;
  serverError: number;
}

// Traffic category config for stacked chart
const TRAFFIC_CATEGORIES = [
  { key: 'guaranteed', label: 'Guaranteed', color: 'bg-green-500 dark:bg-green-600', description: 'Successfully served guaranteed traffic' },
  { key: 'burst', label: 'Burst', color: 'bg-blue-500 dark:bg-blue-600', description: 'Successfully served burst traffic' },
  { key: 'dropped', label: 'Rate Limited', color: 'bg-yellow-500 dark:bg-yellow-600', description: 'Not served - exceeds guaranteed+burst limits' },
  { key: 'clientError', label: 'Client Errors', color: 'bg-orange-500 dark:bg-orange-600', description: 'Client-side errors (4xx) - bad request, auth, etc.' },
  { key: 'serverError', label: 'Server Errors', color: 'bg-red-500 dark:bg-red-600', description: 'Server-side errors (5xx)' },
] as const;

// Area colors for SVG fill (matching Tailwind classes)
const AREA_COLORS = {
  guaranteed: { light: '#22c55e', dark: '#16a34a' },  // green-500/600
  burst: { light: '#3b82f6', dark: '#2563eb' },       // blue-500/600
  dropped: { light: '#eab308', dark: '#ca8a04' },     // yellow-500/600
  clientError: { light: '#f97316', dark: '#ea580c' }, // orange-500/600
  serverError: { light: '#ef4444', dark: '#dc2626' }, // red-500/600
};

// Stacked area chart for traffic breakdown
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
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400">
        {emptyMessage}
      </div>
    );
  }

  const width = 800;
  const height = 192;
  const padding = { top: 10, right: 10, bottom: 10, left: 10 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Find max total for scaling
  const maxTotal = Math.max(
    ...data.map(d => d.guaranteed + d.burst + d.dropped + d.clientError + d.serverError),
    1
  );

  // Calculate cumulative values for stacking (bottom to top: guaranteed, burst, dropped, clientError, serverError)
  const stackOrder = ['guaranteed', 'burst', 'dropped', 'clientError', 'serverError'] as const;

  // Generate area paths for each category
  const areas = stackOrder.map((key, layerIndex) => {
    // Calculate cumulative bottom and top for this layer
    const points: { x: number; y0: number; y1: number }[] = data.map((point, i) => {
      const x = padding.left + (i / (data.length - 1 || 1)) * chartWidth;

      // Sum of all layers below this one
      let y0Sum = 0;
      for (let j = 0; j < layerIndex; j++) {
        y0Sum += point[stackOrder[j] as keyof TrafficDataPoint] as number;
      }

      // Sum including this layer
      const y1Sum = y0Sum + (point[key as keyof TrafficDataPoint] as number);

      // Convert to y coordinates (inverted because SVG y goes down)
      const y0 = height - padding.bottom - (y0Sum / maxTotal) * chartHeight;
      const y1 = height - padding.bottom - (y1Sum / maxTotal) * chartHeight;

      return { x, y0, y1 };
    });

    // Build path: top edge forward, then bottom edge backward
    const topPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y1}`).join(' ');
    const bottomPath = [...points].reverse().map((p, i) => `${i === 0 ? 'L' : 'L'} ${p.x} ${p.y0}`).join(' ');
    const path = `${topPath} ${bottomPath} Z`;

    const category = TRAFFIC_CATEGORIES.find(c => c.key === key)!;
    const color = AREA_COLORS[key as keyof typeof AREA_COLORS];

    return { key, path, category, color };
  });

  // Hover detection zones (vertical slices)
  const sliceWidth = chartWidth / data.length;

  // Calculate tick interval - for 24h show every 4 hours, for 7d/30d show fewer
  const tickInterval = range === '24h' ? 4 : Math.ceil(data.length / 7);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-48"
        preserveAspectRatio="none"
      >
        {/* Vertical gridlines (behind chart data) */}
        {data.map((point, i) => {
          const x = padding.left + (i / (data.length - 1 || 1)) * chartWidth;
          const midnight = isMidnight(point.bucket);
          return (
            <line
              key={`grid-${i}`}
              x1={x}
              y1={padding.top}
              x2={x}
              y2={height - padding.bottom}
              stroke={midnight ? 'rgba(156,163,175,0.5)' : 'rgba(156,163,175,0.2)'}
              strokeWidth={midnight ? 2 : 0.5}
            />
          );
        })}

        {/* Area layers */}
        {areas.map(({ key, path, color }) => (
          <path
            key={key}
            d={path}
            className="transition-opacity duration-150"
            fill={color.light}
            opacity={hoveredIndex !== null ? 0.6 : 0.8}
          />
        ))}

        {/* Hover detection zones */}
        {data.map((_, i) => (
          <rect
            key={i}
            x={padding.left + i * sliceWidth}
            y={padding.top}
            width={sliceWidth}
            height={chartHeight}
            fill="transparent"
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}

        {/* Hover line */}
        {hoveredIndex !== null && (
          <line
            x1={padding.left + (hoveredIndex / (data.length - 1 || 1)) * chartWidth}
            y1={padding.top}
            x2={padding.left + (hoveredIndex / (data.length - 1 || 1)) * chartWidth}
            y2={height - padding.bottom}
            stroke="rgba(255,255,255,0.7)"
            strokeWidth="1.5"
            strokeDasharray="4 2"
          />
        )}
      </svg>

      {/* X-axis tick labels */}
      <div className="relative h-5 mt-1">
        {data.map((point, i) => {
          // Show tick at interval OR at midnight (for date context)
          const showTick = i === 0 || i === data.length - 1 || i % tickInterval === 0 || isMidnight(point.bucket);
          if (!showTick) return null;
          const x = (i / (data.length - 1 || 1)) * 100;
          const midnight = isMidnight(point.bucket);
          return (
            <span
              key={`tick-${i}`}
              className={`absolute text-xs transform -translate-x-1/2 ${
                midnight ? 'text-gray-300 font-medium' : 'text-gray-400'
              }`}
              style={{ left: `${x}%` }}
            >
              {formatTickLabel(point.bucket, range)}
            </span>
          );
        })}
        <span className="absolute left-1/2 transform -translate-x-1/2 text-xs text-gray-500">
          UTC
        </span>
      </div>

      {/* Tooltip */}
      {hoveredIndex !== null && data[hoveredIndex] && (
        <div
          className="absolute z-10 pointer-events-none"
          style={{
            left: `${((hoveredIndex / (data.length - 1 || 1)) * 100)}%`,
            top: 0,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="bg-gray-900 dark:bg-gray-700 text-white text-xs px-3 py-2 rounded shadow-lg whitespace-nowrap">
            <div className="font-medium mb-1">{formatBucketLabel(data[hoveredIndex].bucket, range)}</div>
            {TRAFFIC_CATEGORIES.map(cat => {
              const value = data[hoveredIndex][cat.key as keyof TrafficDataPoint] as number;
              if (value === 0) return null;
              return (
                <div key={cat.key} className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-sm ${cat.color}`} />
                  <span>{cat.label}: {formatValue(value)}</span>
                </div>
              );
            })}
            <div className="border-t border-gray-600 mt-1 pt-1 font-medium">
              Total: {formatValue(
                data[hoveredIndex].guaranteed +
                data[hoveredIndex].burst +
                data[hoveredIndex].dropped +
                data[hoveredIndex].clientError +
                data[hoveredIndex].serverError
              )}
            </div>
          </div>
        </div>
      )}
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

// Response time data point type
interface ResponseTimeDataPoint {
  bucket: string;
  avgResponseTimeMs: number;
}

// Response time chart with 1-second threshold visualization
const THRESHOLD_MS = 1000; // 1 second threshold

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
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400">
        {emptyMessage}
      </div>
    );
  }

  const width = 800;
  const height = 192;
  const padding = { top: 20, right: 10, bottom: 10, left: 10 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Find max value for scaling
  // If any data exceeds threshold, show threshold context (1200ms min)
  // Otherwise, scale to 1.3x the max data value for better visualization
  const dataMax = Math.max(...data.map(d => d.avgResponseTimeMs));
  const maxValue = dataMax >= THRESHOLD_MS
    ? Math.max(dataMax, THRESHOLD_MS * 1.2)
    : Math.max(dataMax * 1.3, 100); // At least 100ms for small values

  // Calculate Y position for a value
  const getY = (value: number) => {
    return height - padding.bottom - (value / maxValue) * chartHeight;
  };

  // Calculate X position for an index
  const getX = (index: number) => {
    return padding.left + (index / (data.length - 1 || 1)) * chartWidth;
  };

  // Threshold line Y position
  const thresholdY = getY(THRESHOLD_MS);

  // Build the line path
  const linePath = data
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(point.avgResponseTimeMs)}`)
    .join(' ');

  // Build area path (fill under the line)
  const areaPath = `${linePath} L ${getX(data.length - 1)} ${height - padding.bottom} L ${getX(0)} ${height - padding.bottom} Z`;

  // Check if any point exceeds threshold
  const hasExceededThreshold = data.some(d => d.avgResponseTimeMs >= THRESHOLD_MS);

  // Calculate 24-hour average
  const avgResponseTime = data.reduce((sum, d) => sum + d.avgResponseTimeMs, 0) / data.length;
  const avgY = getY(avgResponseTime);

  // Hover detection zones
  const sliceWidth = chartWidth / data.length;

  // Calculate tick interval - for 24h show every 4 hours, for 7d/30d show fewer
  const tickInterval = range === '24h' ? 4 : Math.ceil(data.length / 7);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-48"
        preserveAspectRatio="none"
      >
        {/* Vertical gridlines (behind chart data) */}
        {data.map((point, i) => {
          const x = getX(i);
          const midnight = isMidnight(point.bucket);
          return (
            <line
              key={`grid-${i}`}
              x1={x}
              y1={padding.top}
              x2={x}
              y2={height - padding.bottom}
              stroke={midnight ? 'rgba(156,163,175,0.5)' : 'rgba(156,163,175,0.2)'}
              strokeWidth={midnight ? 2 : 0.5}
            />
          );
        })}

        {/* Danger zone background (above threshold) - only show if threshold is visible */}
        {dataMax >= THRESHOLD_MS * 0.5 && (
          <rect
            x={padding.left}
            y={padding.top}
            width={chartWidth}
            height={Math.max(0, thresholdY - padding.top)}
            fill="rgba(239, 68, 68, 0.1)"
          />
        )}

        {/* Area under the line with gradient based on threshold */}
        <defs>
          <linearGradient id="responseTimeGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={hasExceededThreshold ? '#ef4444' : '#8b5cf6'} stopOpacity="0.4" />
            <stop offset="100%" stopColor={hasExceededThreshold ? '#ef4444' : '#8b5cf6'} stopOpacity="0.1" />
          </linearGradient>
        </defs>
        <path
          d={areaPath}
          fill="url(#responseTimeGradient)"
        />

        {/* Line segments - colored based on threshold */}
        {data.slice(0, -1).map((point, i) => {
          const nextPoint = data[i + 1];
          const isAboveThreshold = point.avgResponseTimeMs >= THRESHOLD_MS || nextPoint.avgResponseTimeMs >= THRESHOLD_MS;
          return (
            <line
              key={i}
              x1={getX(i)}
              y1={getY(point.avgResponseTimeMs)}
              x2={getX(i + 1)}
              y2={getY(nextPoint.avgResponseTimeMs)}
              stroke={isAboveThreshold ? '#ef4444' : '#8b5cf6'}
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          );
        })}

        {/* Data points */}
        {data.map((point, i) => {
          const isAboveThreshold = point.avgResponseTimeMs >= THRESHOLD_MS;
          return (
            <circle
              key={i}
              cx={getX(i)}
              cy={getY(point.avgResponseTimeMs)}
              r={hoveredIndex === i ? 5 : 3}
              fill={isAboveThreshold ? '#ef4444' : '#8b5cf6'}
              stroke="white"
              strokeWidth="1.5"
              className="transition-all duration-150"
            />
          );
        })}

        {/* 24-hour average line */}
        <line
          x1={padding.left}
          y1={avgY}
          x2={width - padding.right}
          y2={avgY}
          stroke="#10b981"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          opacity="0.8"
        />

        {/* Average label */}
        <text
          x={padding.left + 5}
          y={avgY - 5}
          fill="#10b981"
          fontSize="10"
          fontWeight="500"
        >
          avg {formatValue(avgResponseTime)}
        </text>

        {/* Threshold line - only show if data approaches threshold */}
        {dataMax >= THRESHOLD_MS * 0.5 && (
          <>
            <line
              x1={padding.left}
              y1={thresholdY}
              x2={width - padding.right}
              y2={thresholdY}
              stroke="#ef4444"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              opacity="0.7"
            />

            {/* Threshold label */}
            <text
              x={width - padding.right - 5}
              y={thresholdY - 5}
              fill="#ef4444"
              fontSize="10"
              textAnchor="end"
              fontWeight="500"
            >
              1s threshold
            </text>
          </>
        )}

        {/* Hover detection zones */}
        {data.map((_, i) => (
          <rect
            key={i}
            x={padding.left + i * sliceWidth}
            y={padding.top}
            width={sliceWidth}
            height={chartHeight}
            fill="transparent"
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}

        {/* Hover line */}
        {hoveredIndex !== null && (
          <line
            x1={getX(hoveredIndex)}
            y1={padding.top}
            x2={getX(hoveredIndex)}
            y2={height - padding.bottom}
            stroke="rgba(255,255,255,0.7)"
            strokeWidth="1.5"
            strokeDasharray="4 2"
          />
        )}
      </svg>

      {/* X-axis tick labels */}
      <div className="relative h-5 mt-1">
        {data.map((point, i) => {
          // Show tick at interval OR at midnight (for date context)
          const showTick = i === 0 || i === data.length - 1 || i % tickInterval === 0 || isMidnight(point.bucket);
          if (!showTick) return null;
          const x = (i / (data.length - 1 || 1)) * 100;
          const midnight = isMidnight(point.bucket);
          return (
            <span
              key={`tick-${i}`}
              className={`absolute text-xs transform -translate-x-1/2 ${
                midnight ? 'text-gray-300 font-medium' : 'text-gray-400'
              }`}
              style={{ left: `${x}%` }}
            >
              {formatTickLabel(point.bucket, range)}
            </span>
          );
        })}
        <span className="absolute left-1/2 transform -translate-x-1/2 text-xs text-gray-500">
          UTC
        </span>
      </div>

      {/* Tooltip */}
      {hoveredIndex !== null && data[hoveredIndex] && (
        <div
          className="absolute z-10 pointer-events-none"
          style={{
            left: `${((hoveredIndex / (data.length - 1 || 1)) * 100)}%`,
            top: 0,
            transform: 'translateX(-50%)',
          }}
        >
          <div className={`text-white text-xs px-3 py-2 rounded shadow-lg whitespace-nowrap ${
            data[hoveredIndex].avgResponseTimeMs >= THRESHOLD_MS
              ? 'bg-red-600'
              : 'bg-gray-900 dark:bg-gray-700'
          }`}>
            <div className="font-medium">{formatBucketLabel(data[hoveredIndex].bucket, range)}</div>
            <div className="flex items-center gap-1">
              <span>Avg:</span>
              <span className="font-bold">{formatValue(data[hoveredIndex].avgResponseTimeMs)}</span>
              {data[hoveredIndex].avgResponseTimeMs >= THRESHOLD_MS && (
                <span className="text-yellow-300">⚠</span>
              )}
            </div>
          </div>
        </div>
      )}
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

function SealStatsPage() {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [testMenuOpen, setTestMenuOpen] = useState(false);

  const utils = trpc.useUtils();

  // Fetch summary stats
  const { data: summary, isLoading: summaryLoading } = trpc.stats.getSummary.useQuery({
    serviceType: 'seal',
  });

  // Fetch traffic breakdown over time (for stacked chart)
  const { data: trafficData, isLoading: trafficLoading } = trpc.stats.getTraffic.useQuery({
    serviceType: 'seal',
    range: timeRange,
  });

  // Fetch response time over time
  const { data: rtData, isLoading: rtLoading } = trpc.stats.getResponseTime.useQuery({
    serviceType: 'seal',
    range: timeRange,
  });

  const invalidateAll = () => {
    utils.stats.getSummary.invalidate();
    utils.stats.getTraffic.invalidate();
    utils.stats.getResponseTime.invalidate();
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

  const isLoading = injectTestData.isPending || injectDemoData.isPending || clearStats.isPending;

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
        injectTestData.mutate({ serviceType: 'seal', hoursOfData: 1, requestsPerHour: 100 });
        break;
      case 'inject1hDemo':
        // Single hour of nice demo data (just guaranteed + a few burst)
        injectTestData.mutate({ serviceType: 'seal', hoursOfData: 1, requestsPerHour: 80 });
        break;
      case 'clear':
        clearStats.mutate({ serviceType: 'seal' });
        break;
      case 'injectDemo':
        injectDemoData.mutate({ serviceType: 'seal' });
        break;
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="pb-6 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">Seal Statistics</h1>
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
                        Inject 1H Test
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTestAction('inject1hDemo')}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Inject 1H Demo
                      </button>
                      <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                      <button
                        type="button"
                        onClick={() => handleTestAction('injectDemo')}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Inject 24H Demo
                      </button>
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
        </div>

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
                    label="Rate Limited"
                    value={formatNumber(summary?.droppedCount ?? 0)}
                    color="yellow"
                  />
                  <StatCard
                    icon={AlertTriangle}
                    label="Client Errors (4xx)"
                    value={formatNumber(summary?.clientErrorCount ?? 0)}
                    color="orange"
                  />
                  <StatCard
                    icon={XCircle}
                    label="Server Errors (5xx)"
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
                  data={trafficData ?? []}
                  range={timeRange}
                  formatValue={formatNumber}
                  emptyMessage="Stats may take up to 1 hour to appear"
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
                  data={rtData ?? []}
                  range={timeRange}
                  formatValue={formatMs}
                  emptyMessage="Stats may take up to 1 hour to appear"
                />
              )}
            </Card>
          </div>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
