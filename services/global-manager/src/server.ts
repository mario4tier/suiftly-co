// Global Manager (gm) - Centralized control plane for Suiftly infrastructure
//
// Environment variables:
//   GM_PORT - Server port (default: 22600)
//   GM_HOST - Server host (default: 0.0.0.0)
// Deployment type from /etc/walrus/system.conf (DEPLOYMENT_TYPE=test|production)

import Fastify from 'fastify';
import { z } from 'zod';
import type { VaultType } from '@walrus/vault-codec';
import { getGlobalVaultTypes } from '@walrus/server-configs';
import { db, adminNotifications } from '@suiftly/database';
import { getMockClockState, setMockClockState } from '@suiftly/database/test-kv';
import { desc, eq, and } from 'drizzle-orm';
import { dbClock } from '@suiftly/shared/db-clock';
import { isTestDeployment } from './config/lm-config.js';
import {
  queueSyncCustomer,
  queueSyncCustomerAwait,
  queueSyncAll,
  queueSyncAllAwait,
  queueSyncLMStatus,
  queueSyncLMStatusAwait,
  getQueueStats,
  getPendingTasks,
  startPeriodicSync,
  stopPeriodicSync,
  SYNC_ALL_INTERVAL_DEV_MS,
  SYNC_ALL_INTERVAL_PROD_MS,
} from './task-queue.js';

const PORT = parseInt(process.env.GM_PORT || '22600', 10);
const HOST = process.env.GM_HOST || '0.0.0.0';

// ============================================================================
// Zod Schemas
// ============================================================================

// Common schemas
const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'ID must be a positive integer').transform(Number),
});

const customerIdParamSchema = z.object({
  customerId: z.string().regex(/^\d+$/, 'Customer ID must be a positive integer').transform(Number),
});

// Notification schemas
const notificationListQuerySchema = z.object({
  acknowledged: z.enum(['true', 'false']).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().min(1).max(500)).optional(),
});

// Queue schemas
const queueQuerySchema = z.object({
  source: z.enum(['api', 'test', 'manual']).optional().default('api'),
  async: z.enum(['true', 'false']).optional(),
});

const syncAllQuerySchema = z.object({
  source: z.enum(['api', 'test', 'manual']).optional().default('manual'),
  async: z.enum(['true', 'false']).optional(),
});

// Test endpoint schemas
const clockMockBodySchema = z.object({
  time: z.union([z.string(), z.number()]).optional(),
  autoAdvance: z.boolean().optional().default(false),
  timeScale: z.number().positive().optional().default(1.0),
});

const clockAdvanceBodySchema = z.object({
  days: z.number().int().optional(),
  hours: z.number().int().optional(),
  minutes: z.number().int().optional(),
  milliseconds: z.number().int().optional(),
});

const testNotificationBodySchema = z.object({
  severity: z.enum(['info', 'warning', 'error']).optional().default('info'),
  category: z.string().min(1).max(100).optional().default('test'),
  code: z.string().min(1).max(100).optional().default('TEST_NOTIFICATION'),
  message: z.string().min(1).max(1000).optional().default('This is a test notification'),
});

// Helper to validate and return parsed result or send error
function validate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  reply: any
): z.output<T> | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({
      error: 'Validation failed',
      details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    });
    return null;
  }
  return result.data;
}

const server = Fastify({
  logger: {
    level: isTestDeployment() ? 'debug' : 'info',
  },
});

// Health check endpoint (both paths for direct and proxied access)
const healthResponse = async () => ({
  status: 'up',
  service: 'global-manager',
  timestamp: new Date().toISOString(),
});

server.get('/health', healthResponse);
server.get('/api/health', healthResponse);

// ============================================================================
// Admin Notifications API
// ============================================================================

// List all notifications (most recent first)
server.get('/api/notifications', async (request, reply) => {
  const query = validate(notificationListQuerySchema, request.query, reply);
  if (!query) return;

  const limit = query.limit ?? 100;

  let notifications;
  if (query.acknowledged === 'false') {
    notifications = await db
      .select()
      .from(adminNotifications)
      .where(eq(adminNotifications.acknowledged, false))
      .orderBy(desc(adminNotifications.createdAt))
      .limit(limit);
  } else if (query.acknowledged === 'true') {
    notifications = await db
      .select()
      .from(adminNotifications)
      .where(eq(adminNotifications.acknowledged, true))
      .orderBy(desc(adminNotifications.createdAt))
      .limit(limit);
  } else {
    notifications = await db
      .select()
      .from(adminNotifications)
      .orderBy(desc(adminNotifications.createdAt))
      .limit(limit);
  }

  return {
    notifications: notifications.map((n) => ({
      ...n,
      details: n.details ? JSON.parse(n.details) : null,
    })),
    count: notifications.length,
  };
});

// Get notification counts by severity
server.get('/api/notifications/counts', async () => {
  const notifications = await db
    .select()
    .from(adminNotifications)
    .where(eq(adminNotifications.acknowledged, false));

  const counts = {
    total: notifications.length,
    error: 0,
    warning: 0,
    info: 0,
  };

  for (const n of notifications) {
    if (n.severity === 'error') counts.error++;
    else if (n.severity === 'warning') counts.warning++;
    else if (n.severity === 'info') counts.info++;
  }

  return counts;
});

// Acknowledge (dismiss) a notification
server.post('/api/notifications/:id/acknowledge', async (request, reply) => {
  const params = validate(idParamSchema, request.params, reply);
  if (!params) return;

  const [updated] = await db
    .update(adminNotifications)
    .set({
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: 'admin', // Could be extended with actual user tracking
    })
    .where(eq(adminNotifications.notificationId, params.id))
    .returning();

  if (!updated) {
    return reply.status(404).send({ error: 'Notification not found' });
  }

  return { success: true, notification: updated };
});

// Acknowledge all unacknowledged notifications
server.post('/api/notifications/acknowledge-all', async () => {
  const result = await db
    .update(adminNotifications)
    .set({
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: 'admin',
    })
    .where(eq(adminNotifications.acknowledged, false))
    .returning({ notificationId: adminNotifications.notificationId });

  return { success: true, acknowledgedCount: result.length };
});

// Delete a notification permanently
server.delete('/api/notifications/:id', async (request, reply) => {
  const params = validate(idParamSchema, request.params, reply);
  if (!params) return;

  const [deleted] = await db
    .delete(adminNotifications)
    .where(eq(adminNotifications.notificationId, params.id))
    .returning();

  if (!deleted) {
    return reply.status(404).send({ error: 'Notification not found' });
  }

  return { success: true };
});

// Delete all acknowledged notifications
server.delete('/api/notifications/acknowledged', async () => {
  const result = await db
    .delete(adminNotifications)
    .where(eq(adminNotifications.acknowledged, true))
    .returning({ notificationId: adminNotifications.notificationId });

  return { success: true, deletedCount: result.length };
});

// ============================================================================
// Task Queue API
// ============================================================================

// Queue a sync for a specific customer (called by API server after deposit, etc.)
// Default: waits for completion (synchronous)
// Use ?async=true to return immediately without waiting
server.post('/api/queue/sync-customer/:customerId', async (request, reply) => {
  const params = validate(customerIdParamSchema, request.params, reply);
  if (!params) return;

  const query = validate(queueQuerySchema, request.query, reply);
  if (!query) return;

  const runAsync = query.async === 'true';

  let task;
  if (runAsync) {
    // Async mode - return immediately (for production API server calls)
    task = queueSyncCustomer(params.customerId, query.source);
    if (task) {
      return { success: true, queued: true, taskId: task.id };
    } else {
      return { success: true, queued: false, reason: 'deduplicated' };
    }
  } else {
    // Await mode (default) - wait for completion
    task = await queueSyncCustomerAwait(params.customerId, query.source);
    return { success: true, queued: !!task, completed: true, taskId: task?.id };
  }
});

// Queue a sync-all (on-demand trigger)
// Default: waits for completion
// Use ?async=true to return immediately without waiting
server.post('/api/queue/sync-all', async (request, reply) => {
  const query = validate(syncAllQuerySchema, request.query, reply);
  if (!query) return;

  const runAsync = query.async === 'true';

  let task;
  if (runAsync) {
    // Async mode - return immediately (for periodic timer)
    task = queueSyncAll(query.source);
    if (task) {
      return { success: true, queued: true, taskId: task.id };
    } else {
      return { success: true, queued: false, reason: 'deduplicated' };
    }
  } else {
    // Await mode (default) - wait for completion
    task = await queueSyncAllAwait(query.source);
    return { success: true, queued: !!task, completed: true, taskId: task?.id };
  }
});

// Queue a sync-lm-status (on-demand LM polling)
// Default: waits for completion
// Use ?async=true to return immediately without waiting
server.post('/api/queue/sync-lm-status', async (request, reply) => {
  const query = validate(syncAllQuerySchema, request.query, reply);
  if (!query) return;

  const runAsync = query.async === 'true';

  let task;
  if (runAsync) {
    task = queueSyncLMStatus(query.source);
    if (task) {
      return { success: true, queued: true, taskId: task.id };
    } else {
      return { success: true, queued: false, reason: 'deduplicated' };
    }
  } else {
    task = await queueSyncLMStatusAwait(query.source);
    return { success: true, queued: !!task, completed: true, taskId: task?.id };
  }
});

// Get queue status
server.get('/api/queue/stats', async () => {
  return getQueueStats();
});

// Get pending tasks (for debugging)
server.get('/api/queue/pending', async () => {
  return { tasks: getPendingTasks() };
});

// ============================================================================
// Test Endpoints (development only)
// ============================================================================

if (isTestDeployment()) {
  const { dbClockProvider } = await import('@suiftly/shared/db-clock');

  // Configure test_kv sync for cross-process clock sharing
  dbClockProvider.configureTestKvSync(getMockClockState, setMockClockState);
  dbClockProvider.enableTestKvSync();

  // Clock mock endpoints - GM is the single source of truth
  // Sets local mock clock AND writes to test_kv for other processes
  server.post('/api/test/clock/mock', async (request, reply) => {
    const body = validate(clockMockBodySchema, request.body || {}, reply);
    if (!body) return;

    let mockTime: Date | undefined;
    if (body.time !== undefined) {
      mockTime = typeof body.time === 'string' ? new Date(body.time) : new Date(body.time);
      if (isNaN(mockTime.getTime())) {
        return reply.status(400).send({ error: 'Invalid date/time value' });
      }
    }

    // Set local mock clock AND persist to test_kv
    const mockClock = await dbClockProvider.useMockClockAndSync({
      currentTime: mockTime,
      autoAdvance: body.autoAdvance,
      timeScale: body.timeScale,
    });

    return {
      success: true,
      type: 'mock',
      currentTime: mockClock.now().toISOString(),
      config: {
        autoAdvance: body.autoAdvance,
        timeScale: body.timeScale,
      },
    };
  });

  server.post('/api/test/clock/real', async () => {
    // Reset local clock AND clear test_kv
    await dbClockProvider.useRealClockAndSync();
    return {
      success: true,
      type: 'real',
      currentTime: new Date().toISOString(),
    };
  });

  server.get('/api/test/clock', async () => {
    // Sync from test_kv to ensure we have latest state
    await dbClockProvider.syncFromTestKv();
    const clock = dbClockProvider.getClock();
    const isMock = dbClockProvider.isUsingMockClock();
    return {
      type: isMock ? 'mock' : 'real',
      currentTime: clock.now().toISOString(),
    };
  });

  // Advance mock clock by specific duration
  server.post('/api/test/clock/advance', async (request, reply) => {
    const mockClock = dbClockProvider.getMockClock();
    if (!mockClock) {
      return reply.status(400).send({ error: 'Mock clock not enabled. Use /api/test/clock/mock first.' });
    }

    const body = validate(clockAdvanceBodySchema, request.body || {}, reply);
    if (!body) return;

    // Advance by each specified unit
    if (body.days) {
      mockClock.advanceDays(body.days);
    }
    if (body.hours) {
      mockClock.advanceHours(body.hours);
    }
    if (body.minutes) {
      mockClock.advanceMinutes(body.minutes);
    }
    if (body.milliseconds) {
      mockClock.advance(body.milliseconds);
    }

    // Persist updated time to test_kv
    await dbClockProvider.writeToTestKv();

    return {
      success: true,
      currentTime: mockClock.now().toISOString(),
      advanced: {
        days: body.days ?? 0,
        hours: body.hours ?? 0,
        minutes: body.minutes ?? 0,
        milliseconds: body.milliseconds ?? 0,
      },
    };
  });

  // Create a test notification
  server.post('/api/test/notification', async (request, reply) => {
    const body = validate(testNotificationBodySchema, request.body || {}, reply);
    if (!body) return;

    const [notification] = await db
      .insert(adminNotifications)
      .values({
        severity: body.severity as 'info' | 'warning' | 'error',
        category: body.category,
        code: body.code,
        message: body.message,
        details: JSON.stringify({ createdAt: new Date().toISOString(), test: true }),
      })
      .returning();

    return { success: true, notification };
  });

  // Create sample notifications of each severity
  server.post('/api/test/notifications/samples', async () => {
    const samples = [
      { severity: 'error', category: 'billing', code: 'PAYMENT_FAILED', message: 'Payment processing failed for customer 12345' },
      { severity: 'warning', category: 'system', code: 'HIGH_MEMORY', message: 'Memory usage above 80% threshold' },
      { severity: 'info', category: 'security', code: 'NEW_LOGIN', message: 'New login from IP 192.168.1.100' },
    ];

    const notifications = [];
    for (const sample of samples) {
      const [n] = await db
        .insert(adminNotifications)
        .values({
          ...sample,
          details: JSON.stringify({ timestamp: new Date().toISOString() }),
        })
        .returning();
      notifications.push(n);
    }

    return { success: true, count: notifications.length, notifications };
  });
}

// ============================================================================
// Admin Notification Helpers
// ============================================================================

/**
 * Log an admin notification with deduplication.
 *
 * Deduplication behavior:
 * - If no existing unacknowledged notification with same code+category → create new
 * - If existing notification with identical message → skip (true duplicate)
 * - If existing notification with different message → update it with new message/details
 *
 * This ensures admins see the latest error state without notification spam.
 *
 * @returns The notification ID if created/updated, null if skipped (identical)
 */
async function logAdminNotificationDedup(params: {
  severity: 'info' | 'warning' | 'error';
  category: string;
  code: string;
  message: string;
  details?: any;
}): Promise<number | null> {
  // Check for existing unacknowledged notification with same code and category
  const existing = await db
    .select({
      notificationId: adminNotifications.notificationId,
      message: adminNotifications.message,
    })
    .from(adminNotifications)
    .where(
      and(
        eq(adminNotifications.code, params.code),
        eq(adminNotifications.category, params.category),
        eq(adminNotifications.acknowledged, false)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const existingNotif = existing[0];

    // If message is identical, skip (true duplicate)
    if (existingNotif.message === params.message) {
      return null;
    }

    // Message changed - update the existing notification with new state
    await db
      .update(adminNotifications)
      .set({
        severity: params.severity,
        message: params.message,
        details: params.details ? JSON.stringify(params.details) : null,
        createdAt: new Date(), // Update timestamp to reflect new state
      })
      .where(eq(adminNotifications.notificationId, existingNotif.notificationId));

    // Log to console for immediate visibility
    const logLevel = params.severity === 'error' ? console.error : console.warn;
    logLevel(`[ADMIN NOTIFICATION] ${params.severity.toUpperCase()} (updated): ${params.code} - ${params.message}`);

    return existingNotif.notificationId;
  }

  // Create new notification
  const [notification] = await db
    .insert(adminNotifications)
    .values({
      severity: params.severity,
      category: params.category,
      code: params.code,
      message: params.message,
      details: params.details ? JSON.stringify(params.details) : null,
    })
    .returning({ notificationId: adminNotifications.notificationId });

  // Log to console for immediate visibility
  const logLevel = params.severity === 'error' ? console.error : console.warn;
  logLevel(`[ADMIN NOTIFICATION] ${params.severity.toUpperCase()}: ${params.code} - ${params.message}`);

  return notification.notificationId;
}

// ============================================================================
// Vault Status API (for Admin Dashboard KVCrypt Debug)
// ============================================================================

/**
 * Vault types this GM instance manages.
 * Loaded from server_configs.py via @walrus/server-configs (data_tx field).
 */
const configuredVaultTypes = getGlobalVaultTypes() as VaultType[];

// Get vault status from data_tx
server.get('/api/vault/status', async () => {
  const { createVaultReader } = await import('@walrus/vault-codec');

  const reader = createVaultReader({
    storageDir: '/opt/syncf/data_tx',
  });

  // Get status for configured vault types (from server_configs.py data_tx field)
  const vaults: Record<string, {
    vaultType: string;
    latest: { seq: number; pg: number; filename: string } | null;
    previous: { seq: number; pg: number; filename: string } | null;
    allVersions: Array<{ seq: number; pg: number; filename: string }>;
  }> = {};

  for (const vaultType of configuredVaultTypes) {
    try {
      const versions = await reader.listVersions(vaultType);
      const latest = versions[0] || null;
      const previous = versions[1] || null;

      vaults[vaultType] = {
        vaultType,
        latest,
        previous,
        allVersions: versions.slice(0, 10), // Limit to 10 versions
      };
    } catch {
      vaults[vaultType] = {
        vaultType,
        latest: null,
        previous: null,
        allVersions: [],
      };
    }
  }

  return { vaults };
});

// Get Local Manager statuses (live polling)
server.get('/api/lm/status', async () => {
  // Poll LM directly for live status
  // LM reports all its expected vault types in the health response
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

  const managers: LMStatus[] = [];

  // Local LM (development)
  const localLm: LMStatus = {
    name: 'Local LM',
    host: 'http://localhost:22610',
    reachable: false,
    vaults: [],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch('http://localhost:22610/health', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json() as {
        vaults: Array<{
          type: string;
          customerCount: number;
          applied: { seq: number; at: string } | null;
          processing: { seq: number; startedAt: string; error: string | null } | null;
        }>;
      };

      localLm.reachable = true;

      // Map LM vault status (LM reports ALL its expected vault types)
      localLm.vaults = data.vaults.map((v) => ({
        type: v.type,
        appliedSeq: v.applied?.seq ?? 0,
        processingSeq: v.processing?.seq ?? null,
        processingError: v.processing?.error ?? null,
        customerCount: v.customerCount,
      }));

      // Store raw LM data for debugging
      localLm.rawData = data;

      // Derive LM error from vault status (LM already reports all expected types)
      const errors: string[] = [];

      for (const vault of localLm.vaults) {
        // Check for processing error
        if (vault.processingError) {
          errors.push(`${vault.type}: ${vault.processingError}`);
        }
        // Check for vault not applied (no data loaded yet)
        else if (vault.appliedSeq === 0 && vault.processingSeq === null) {
          errors.push(`${vault.type}: not loaded`);
        }
      }

      // Set LM error if any vault has issues
      if (errors.length > 0) {
        localLm.error = errors.join('; ');

        // Log admin notification (deduplicated by code)
        await logAdminNotificationDedup({
          severity: 'error',
          category: 'lm-sync',
          code: `LM_VAULT_ERROR_${localLm.name.replace(/\s+/g, '_').toUpperCase()}`,
          message: `LM "${localLm.name}" has vault sync errors: ${errors.join('; ')}`,
          details: {
            lmName: localLm.name,
            lmHost: localLm.host,
            errors,
            lmVaults: localLm.vaults,
          },
        });
      }
    } else {
      localLm.error = `HTTP ${res.status}`;
    }
  } catch (err) {
    localLm.error = err instanceof Error ? err.message : 'Connection failed';
  }

  managers.push(localLm);

  return { managers };
});

// ============================================================================
// Sync Overview API (for Admin Dashboard)
// ============================================================================

// Get fleet-wide sync overview
server.get('/api/sync/overview', async () => {
  const { getLMStatuses, getMinAppliedSeq } = await import('./tasks/poll-lm-status.js');
  const { systemControl } = await import('@suiftly/database');
  const { eq } = await import('drizzle-orm');

  // Get current vault seq from system_control
  const [control] = await db
    .select()
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  const currentVaultSeq = control?.smaVaultSeq ?? 0;

  // Get LM statuses
  const lmStatuses = await getLMStatuses();
  const minAppliedSeq = await getMinAppliedSeq('sma');

  // Calculate sync status
  // LM is "reachable" if we've seen it recently (within last 30 seconds)
  const recentThreshold = new Date(Date.now() - 30000);
  const lmsReachable = lmStatuses.filter(s => s.lastSeenAt && s.lastSeenAt > recentThreshold).length;
  const lmsTotal = lmStatuses.length;

  // Fleet is synced if all LMs have appliedSeq >= currentVaultSeq
  const allSynced = minAppliedSeq !== null && minAppliedSeq >= currentVaultSeq;

  return {
    vault: {
      currentSeq: currentVaultSeq,
      contentHash: control?.smaVaultContentHash ?? null,
    },
    lms: {
      total: lmsTotal,
      reachable: lmsReachable,
      minAppliedSeq,
      allSynced,
      statuses: lmStatuses.map(s => {
        const isReachable = s.lastSeenAt && s.lastSeenAt > recentThreshold;
        return {
          id: s.lmId,
          name: s.displayName,
          host: s.host,
          region: s.region,
          reachable: isReachable,
          appliedSeq: s.appliedSeq,
          processingSeq: s.processingSeq,
          customerCount: s.customerCount,
          lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
          lastError: s.lastError,
        };
      }),
    },
    syncStatus: allSynced ? 'synced' : 'pending',
  };
});

// ============================================================================
// Infrastructure Stats API (for Admin Dashboard InfraStats page)
// ============================================================================

// Zod schema for infra range query
const infraRangeQuerySchema = z.object({
  range: z.enum(['24h', '7d', '2y']).optional().default('24h'),
});

// Service type names for display
const SERVICE_TYPE_NAMES: Record<number, string> = {
  1: 'Seal',
  2: 'RPC',
  3: 'GraphQL',
};

// Event type names for display
const EVENT_TYPE_NAMES: Record<number, string> = {
  0: 'Success',
  // Auth/Protocol (10-17)
  10: 'Missing API Key', 11: 'Auth Failed', 12: 'Malformed Request',
  13: 'Header Too Large', 14: 'Request Timeout', 15: 'TLS Handshake Failed',
  16: 'Invalid Route', 17: 'Missing CF Header',
  // IP/Access (20-21)
  20: 'IP Blocked', 21: 'IP Rate Limit',
  // Authorization (30-39)
  30: 'Customer Not Authorized', 31: 'API Key Revoked', 32: 'Customer Not In Map',
  // Backend (50-54)
  50: 'Backend Error 500', 51: 'Backend Error 502', 52: 'Backend Error 503',
  53: 'Backend Error 504', 54: 'Backend Error Other',
  // Infrastructure (60-63)
  60: 'Connection Refused', 61: 'Connection Timeout',
  62: 'No Backend Available', 63: 'Queue Timeout',
};

const ERROR_CATEGORIES = [
  { name: 'Auth/Protocol', range: [10, 17] as const },
  { name: 'IP/Access', range: [20, 21] as const },
  { name: 'Authorization', range: [30, 39] as const },
  { name: 'Backend', range: [50, 54] as const },
  { name: 'Infrastructure', range: [60, 63] as const },
];

// GET /api/infra/summary - Returns counts for ALL time ranges, per service
// Distinguishes between server errors (user-affecting) and client errors (client's fault)
server.get('/api/infra/summary', async () => {
  const { sql } = await import('drizzle-orm');

  // Use dbClock for testable time
  const now = dbClock.now();
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  // Calculate start times from dbClock
  const start24h = new Date(now.getTime() - 24 * MS_PER_HOUR);
  const start7d = new Date(now.getTime() - 7 * MS_PER_DAY);
  const start2y = new Date(now.getTime() - 2 * 365 * MS_PER_DAY);

  type RangeData = {
    total: number;
    serverErrors: number;  // Backend 50-54, Infrastructure 60-63
    clientErrors: number;  // Auth 10-17, IP 20-21, Authz 30-39
    avgTotalMs: number | null;  // For degradation detection
  };
  type ServiceData = { name: string; ranges: Record<string, RangeData> };

  // Helper to process query results by service
  const processServiceResults = (rows: Array<{
    service_type: number;
    total: string;
    server_errors: string;
    client_errors: string;
    avg_total_ms: string | null;
  }>) => {
    const byService: Record<number, RangeData> = {};
    for (const row of rows) {
      byService[row.service_type] = {
        total: Number(row.total),
        serverErrors: Number(row.server_errors),
        clientErrors: Number(row.client_errors),
        avgTotalMs: row.avg_total_ms ? Number(row.avg_total_ms) : null,
      };
    }
    return byService;
  };

  // Query with error categorization
  // 24h from infra_per_hour
  const h24Result = await db.execute(sql`
    SELECT
      service_type,
      COALESCE(SUM(request_count), 0)::bigint as total,
      COALESCE(SUM(CASE WHEN event_type BETWEEN 50 AND 54 OR event_type BETWEEN 60 AND 63
          THEN request_count ELSE 0 END), 0)::bigint as server_errors,
      COALESCE(SUM(CASE WHEN event_type BETWEEN 10 AND 39
          THEN request_count ELSE 0 END), 0)::bigint as client_errors,
      SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms
    FROM infra_per_hour
    WHERE bucket >= ${start24h}
    GROUP BY service_type
  `);
  const h24ByService = processServiceResults(h24Result.rows as any);

  // 7d from infra_per_hour
  const d7Result = await db.execute(sql`
    SELECT
      service_type,
      COALESCE(SUM(request_count), 0)::bigint as total,
      COALESCE(SUM(CASE WHEN event_type BETWEEN 50 AND 54 OR event_type BETWEEN 60 AND 63
          THEN request_count ELSE 0 END), 0)::bigint as server_errors,
      COALESCE(SUM(CASE WHEN event_type BETWEEN 10 AND 39
          THEN request_count ELSE 0 END), 0)::bigint as client_errors,
      SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms
    FROM infra_per_hour
    WHERE bucket >= ${start7d}
    GROUP BY service_type
  `);
  const d7ByService = processServiceResults(d7Result.rows as any);

  // 2y from infra_per_day
  const y2Result = await db.execute(sql`
    SELECT
      service_type,
      COALESCE(SUM(request_count), 0)::bigint as total,
      COALESCE(SUM(CASE WHEN event_type BETWEEN 50 AND 54 OR event_type BETWEEN 60 AND 63
          THEN request_count ELSE 0 END), 0)::bigint as server_errors,
      COALESCE(SUM(CASE WHEN event_type BETWEEN 10 AND 39
          THEN request_count ELSE 0 END), 0)::bigint as client_errors,
      SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms
    FROM infra_per_day
    WHERE bucket >= ${start2y}
    GROUP BY service_type
  `);
  const y2ByService = processServiceResults(y2Result.rows as any);

  // Build response per service
  const emptyRange: RangeData = { total: 0, serverErrors: 0, clientErrors: 0, avgTotalMs: null };
  const services: Record<string, ServiceData> = {};

  for (const [serviceType, name] of Object.entries(SERVICE_TYPE_NAMES)) {
    const st = Number(serviceType);
    services[serviceType] = {
      name,
      ranges: {
        '24h': h24ByService[st] || emptyRange,
        '7d': d7ByService[st] || emptyRange,
        '2y': y2ByService[st] || emptyRange,
      },
    };
  }

  return { services };
});

// Helper to convert bucket to ISO string (handles both Date and string from time_bucket)
const toBucketISO = (bucket: Date | string): string => {
  if (bucket instanceof Date) {
    return bucket.toISOString();
  }
  return new Date(bucket).toISOString();
};

// GET /api/infra/status-bar?range=24h|7d|2y - Returns per-bucket data for status bars, per service
// Two status bars:
// 1. Server status: Green (no errors, fast), Yellow (slow >150ms), Red (server errors affecting users)
// 2. Client status: Shows client-side errors (auth, IP, authz) for attack/abuse monitoring
server.get('/api/infra/status-bar', async (request, reply) => {
  const query = validate(infraRangeQuerySchema, request.query, reply);
  if (!query) return;

  const { sql } = await import('drizzle-orm');

  // Use dbClock for testable time
  const now = dbClock.now();
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  // Error categories:
  // - Server errors (affect users): Backend 50-54, Infrastructure 60-63
  // - Client errors (client's fault): Auth/Protocol 10-17, IP/Access 20-21, Authorization 30-39
  type BucketData = {
    bucket: string;
    total: number;
    serverErrors: number;  // Backend + Infrastructure errors (user-affecting)
    clientErrors: number;  // Auth + IP + Authz errors (client's fault)
    avgTotalMs: number | null;  // For latency-based degradation detection
  };

  // Helper to process rows by service
  const processRows = (rows: Array<{
    service_type: number;
    bucket: Date | string;
    total: string;
    server_errors: string;
    client_errors: string;
    avg_total_ms: string | null;
  }>) => {
    const byService: Record<number, BucketData[]> = {};
    for (const row of rows) {
      const st = row.service_type;
      if (!byService[st]) byService[st] = [];
      byService[st].push({
        bucket: toBucketISO(row.bucket),
        total: Number(row.total),
        serverErrors: Number(row.server_errors),
        clientErrors: Number(row.client_errors),
        avgTotalMs: row.avg_total_ms ? Number(row.avg_total_ms) : null,
      });
    }
    return byService;
  };

  let granularity: 'hour' | 'day' | 'week';
  let byService: Record<number, BucketData[]>;

  // Query with error categorization:
  // - Server errors: event_type 50-54 (Backend) OR 60-63 (Infrastructure)
  // - Client errors: event_type 10-17 (Auth) OR 20-21 (IP) OR 30-39 (Authz)
  if (query.range === '24h') {
    granularity = 'hour';
    const start = new Date(now.getTime() - 24 * MS_PER_HOUR);
    const result = await db.execute(sql`
      SELECT
        service_type,
        bucket,
        SUM(request_count)::bigint as total,
        SUM(CASE WHEN event_type BETWEEN 50 AND 54 OR event_type BETWEEN 60 AND 63
            THEN request_count ELSE 0 END)::bigint as server_errors,
        SUM(CASE WHEN event_type BETWEEN 10 AND 39
            THEN request_count ELSE 0 END)::bigint as client_errors,
        SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms
      FROM infra_per_hour
      WHERE bucket >= ${start}
      GROUP BY service_type, bucket
      ORDER BY service_type, bucket
    `);
    byService = processRows(result.rows as any);
  } else if (query.range === '7d') {
    granularity = 'day';
    const start = new Date(now.getTime() - 7 * MS_PER_DAY);
    const result = await db.execute(sql`
      SELECT
        service_type,
        time_bucket('1 day', bucket) as bucket,
        SUM(request_count)::bigint as total,
        SUM(CASE WHEN event_type BETWEEN 50 AND 54 OR event_type BETWEEN 60 AND 63
            THEN request_count ELSE 0 END)::bigint as server_errors,
        SUM(CASE WHEN event_type BETWEEN 10 AND 39
            THEN request_count ELSE 0 END)::bigint as client_errors,
        SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms
      FROM infra_per_hour
      WHERE bucket >= ${start}
      GROUP BY service_type, time_bucket('1 day', bucket)
      ORDER BY service_type, 2
    `);
    byService = processRows(result.rows as any);
  } else {
    granularity = 'week';
    const start = new Date(now.getTime() - 2 * 365 * MS_PER_DAY);
    const result = await db.execute(sql`
      SELECT
        service_type,
        time_bucket('1 week', bucket) as bucket,
        SUM(request_count)::bigint as total,
        SUM(CASE WHEN event_type BETWEEN 50 AND 54 OR event_type BETWEEN 60 AND 63
            THEN request_count ELSE 0 END)::bigint as server_errors,
        SUM(CASE WHEN event_type BETWEEN 10 AND 39
            THEN request_count ELSE 0 END)::bigint as client_errors,
        SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms
      FROM infra_per_day
      WHERE bucket >= ${start}
      GROUP BY service_type, time_bucket('1 week', bucket)
      ORDER BY service_type, 2
    `);
    byService = processRows(result.rows as any);
  }

  // Build response per service
  const services: Record<string, { name: string; buckets: BucketData[] }> = {};
  for (const [serviceType, name] of Object.entries(SERVICE_TYPE_NAMES)) {
    const st = Number(serviceType);
    services[serviceType] = {
      name,
      buckets: byService[st] || [],
    };
  }

  return { services, granularity };
});

// GET /api/infra/graphs?range=24h|7d|2y - Returns time series data for graphs, per service
server.get('/api/infra/graphs', async (request, reply) => {
  const query = validate(infraRangeQuerySchema, request.query, reply);
  if (!query) return;

  const { sql } = await import('drizzle-orm');

  // Use dbClock for testable time
  const now = dbClock.now();
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  interface GraphBucket {
    bucket: string;
    requests: number;
    avgTotalMs: number | null;
    avgQueueMs: number | null;
    avgConnectMs: number | null;
    avgRtMs: number | null;
  }

  // Helper to process rows by service
  const processRows = (rows: Array<{
    service_type: number;
    bucket: Date | string;
    requests: string;
    avg_total_ms: string | null;
    avg_queue_ms: string | null;
    avg_connect_ms: string | null;
    avg_rt_ms: string | null;
  }>) => {
    const byService: Record<number, GraphBucket[]> = {};
    for (const r of rows) {
      const st = r.service_type;
      if (!byService[st]) byService[st] = [];
      byService[st].push({
        bucket: toBucketISO(r.bucket),
        requests: Number(r.requests),
        avgTotalMs: r.avg_total_ms ? Number(r.avg_total_ms) : null,
        avgQueueMs: r.avg_queue_ms ? Number(r.avg_queue_ms) : null,
        avgConnectMs: r.avg_connect_ms ? Number(r.avg_connect_ms) : null,
        avgRtMs: r.avg_rt_ms ? Number(r.avg_rt_ms) : null,
      });
    }
    return byService;
  };

  let granularity: 'hour' | 'day' | 'week';
  let byService: Record<number, GraphBucket[]>;

  if (query.range === '24h') {
    granularity = 'hour';
    const start = new Date(now.getTime() - 24 * MS_PER_HOUR);
    const result = await db.execute(sql`
      SELECT
        service_type,
        bucket,
        SUM(request_count)::bigint as requests,
        SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms,
        SUM(avg_queue_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_queue_ms,
        SUM(avg_connect_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_connect_ms,
        SUM(avg_rt_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_rt_ms
      FROM infra_per_hour
      WHERE bucket >= ${start}
      GROUP BY service_type, bucket
      ORDER BY service_type, bucket
    `);
    byService = processRows(result.rows as any);
  } else if (query.range === '7d') {
    granularity = 'day';
    const start = new Date(now.getTime() - 7 * MS_PER_DAY);
    const result = await db.execute(sql`
      SELECT
        service_type,
        time_bucket('1 day', bucket) as bucket,
        SUM(request_count)::bigint as requests,
        SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms,
        SUM(avg_queue_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_queue_ms,
        SUM(avg_connect_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_connect_ms,
        SUM(avg_rt_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_rt_ms
      FROM infra_per_hour
      WHERE bucket >= ${start}
      GROUP BY service_type, time_bucket('1 day', bucket)
      ORDER BY service_type, 2
    `);
    byService = processRows(result.rows as any);
  } else {
    granularity = 'week';
    const start = new Date(now.getTime() - 2 * 365 * MS_PER_DAY);
    const result = await db.execute(sql`
      SELECT
        service_type,
        time_bucket('1 week', bucket) as bucket,
        SUM(request_count)::bigint as requests,
        SUM(avg_total_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_total_ms,
        SUM(avg_queue_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_queue_ms,
        SUM(avg_connect_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_connect_ms,
        SUM(avg_rt_ms * request_count) / NULLIF(SUM(request_count), 0) as avg_rt_ms
      FROM infra_per_day
      WHERE bucket >= ${start}
      GROUP BY service_type, time_bucket('1 week', bucket)
      ORDER BY service_type, 2
    `);
    byService = processRows(result.rows as any);
  }

  // Build response per service
  const services: Record<string, { name: string; buckets: GraphBucket[] }> = {};
  for (const [serviceType, name] of Object.entries(SERVICE_TYPE_NAMES)) {
    const st = Number(serviceType);
    services[serviceType] = {
      name,
      buckets: byService[st] || [],
    };
  }

  return { services, granularity };
});

// GET /api/infra/errors?range=24h|7d|2y - Returns error breakdown by category and event_type, per service
server.get('/api/infra/errors', async (request, reply) => {
  const query = validate(infraRangeQuerySchema, request.query, reply);
  if (!query) return;

  const { sql } = await import('drizzle-orm');

  // Use dbClock for testable time
  const now = dbClock.now();
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  // Get error counts by event_type for the selected range
  let start: Date;
  let table: string;
  if (query.range === '24h') {
    start = new Date(now.getTime() - 24 * MS_PER_HOUR);
    table = 'infra_per_hour';
  } else if (query.range === '7d') {
    start = new Date(now.getTime() - 7 * MS_PER_DAY);
    table = 'infra_per_hour';
  } else {
    start = new Date(now.getTime() - 2 * 365 * MS_PER_DAY);
    table = 'infra_per_day';
  }

  const result = await db.execute(sql.raw(`
    SELECT
      service_type,
      event_type,
      SUM(request_count)::bigint as count
    FROM ${table}
    WHERE bucket >= '${start.toISOString()}'::timestamptz
      AND event_type != 0
    GROUP BY service_type, event_type
    ORDER BY service_type, count DESC
  `));

  // Group by service, then by event_type
  const errorsByServiceAndType = new Map<number, Map<number, number>>();
  for (const row of result.rows as Array<{ service_type: number; event_type: number; count: string }>) {
    if (!errorsByServiceAndType.has(row.service_type)) {
      errorsByServiceAndType.set(row.service_type, new Map());
    }
    errorsByServiceAndType.get(row.service_type)!.set(row.event_type, Number(row.count));
  }

  // Build response per service
  type ErrorCategory = {
    name: string;
    range: readonly [number, number];
    total: number;
    types: Array<{ code: number; name: string; count: number }>;
  };

  const buildCategories = (errorsByType: Map<number, number>): ErrorCategory[] => {
    return ERROR_CATEGORIES.map(cat => {
      const types: Array<{ code: number; name: string; count: number }> = [];
      let categoryTotal = 0;

      for (let code = cat.range[0]; code <= cat.range[1]; code++) {
        const count = errorsByType.get(code) || 0;
        if (count > 0) {
          types.push({
            code,
            name: EVENT_TYPE_NAMES[code] || `Unknown (${code})`,
            count,
          });
          categoryTotal += count;
        }
      }

      types.sort((a, b) => b.count - a.count);

      return {
        name: cat.name,
        range: cat.range,
        total: categoryTotal,
        types,
      };
    }).filter(cat => cat.total > 0);
  };

  const services: Record<string, { name: string; categories: ErrorCategory[] }> = {};
  for (const [serviceType, name] of Object.entries(SERVICE_TYPE_NAMES)) {
    const st = Number(serviceType);
    const errorsByType = errorsByServiceAndType.get(st) || new Map();
    services[serviceType] = {
      name,
      categories: buildCategories(errorsByType),
    };
  }

  return { services };
});

// ============================================================================
// Graceful shutdown
// ============================================================================

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down gracefully...`);
  stopPeriodicSync();
  await server.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start() {
  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`Global Manager (gm) listening on http://${HOST}:${PORT}`);

    // Reconcile vault state (data_tx vs DB) on startup
    // This handles scenarios where DB was reset but vault files still exist
    try {
      const { reconcileVaultState } = await import('./tasks/reconcile-vault-state.js');
      const results = await reconcileVaultState();
      const updated = results.filter((r) => r.action === 'updated_db');
      if (updated.length > 0) {
        server.log.info(`Vault state reconciled: ${updated.map((r) => `${r.vaultType} seq ${r.dbSeq} → ${r.newDbSeq}`).join(', ')}`);
      }
    } catch (err) {
      server.log.warn(`Vault reconciliation failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    // Recover any stale seal registration ops on startup
    // This handles scenarios where GM crashed while processing a registration
    try {
      const { recoverStaleOps } = await import('./tasks/process-seal-registrations.js');
      const recoveredOps = await recoverStaleOps();
      if (recoveredOps > 0) {
        server.log.info(`Seal registration ops recovered: ${recoveredOps} stale ops moved back to queue`);
      }
    } catch (err) {
      server.log.warn(`Seal registration recovery failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    // Start periodic tasks:
    // - sync-all (billing, drift): 30s in dev, 5 min in production
    // - sync-lm-status: 5s in both (for fast "Updating..." feedback)
    const syncAllInterval = isTestDeployment()
      ? SYNC_ALL_INTERVAL_DEV_MS   // 30 seconds (test/dev)
      : SYNC_ALL_INTERVAL_PROD_MS; // 5 minutes (production)
    startPeriodicSync(syncAllInterval);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
