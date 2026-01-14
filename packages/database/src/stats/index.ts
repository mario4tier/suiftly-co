/**
 * Stats module exports (STATS_DESIGN.md)
 *
 * Provides stats queries and test helpers for the stats system.
 */

// Test helpers (used by unit tests and /test/stats/* endpoints)
export {
  insertMockHAProxyLogs,
  insertMockMixedLogs,
  refreshStatsAggregate,
  clearCustomerLogs,
  clearAllLogs,
  insertInfraLogs,
  refreshInfraAggregates,
  type MockHAProxyLogOptions,
  type TrafficDistribution,
  type InfraLogOptions,
} from './test-helpers';

// Query functions (STATS_DESIGN.md D4)
export {
  getStatsSummary,
  getUsageStats,
  getResponseTimeStats,
  getTrafficStats,
  getBillableRequestCount,
  type StatsSummary,
  type UsageDataPoint,
  type ResponseTimeDataPoint,
  type TrafficDataPoint,
  type TimeRange,
} from './queries';
