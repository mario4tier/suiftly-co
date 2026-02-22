// Global Manager (gm) - Centralized control plane for Suiftly infrastructure
//
// Environment variables:
//   GM_PORT - Server port (default: 22600)
//   GM_HOST - Server host (default: 0.0.0.0)
// Deployment type from /etc/mhaxbe/system.conf (DEPLOYMENT_TYPE=test|production)

import Fastify from 'fastify';
import { z } from 'zod';
import type { VaultType } from '@mhaxbe/vault-codec';
import { getGlobalVaultTypes } from '@mhaxbe/server-configs';
import { db, adminNotifications, systemControl, billingRecords, customers, customerPaymentMethods, invoicePayments, invoiceLineItems } from '@suiftly/database';
import { getMockClockState, setMockClockState } from '@suiftly/database/test-kv';
import { desc, eq, and, sql, gte, lte, lt, isNotNull, isNull } from 'drizzle-orm';
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
  category: z.string().min(1).max(100).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().min(1).max(500)).optional(),
});

const alarmQuerySchema = z.object({
  category: z.string().min(1).max(100).optional(),
});

const acknowledgeAllQuerySchema = z.object({
  category: z.string().min(1).max(100).optional(),
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
// Includes vault sync state for tests to determine if changes have been processed
const healthResponse = async () => {
  // Get vault state from system_control for sync status visibility
  const [control] = await db
    .select({
      smaVaultSeq: systemControl.smaVaultSeq,
      smaMaxConfigChangeSeq: systemControl.smaMaxConfigChangeSeq,
      smkVaultSeq: systemControl.smkVaultSeq,
    })
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  const smaVaultSeq = control?.smaVaultSeq ?? 0;
  const smaMaxConfigChangeSeq = control?.smaMaxConfigChangeSeq ?? 0;

  return {
    status: 'up',
    service: 'global-manager',
    timestamp: new Date().toISOString(),
    // Vault sync state - used by tests to wait for correct seq
    // hasPending: true means API has marked changes that GM hasn't yet processed into a vault
    vaults: {
      sma: {
        vaultSeq: smaVaultSeq,
        maxConfigChangeSeq: smaMaxConfigChangeSeq,
        hasPending: smaMaxConfigChangeSeq > smaVaultSeq,
      },
      smk: {
        vaultSeq: control?.smkVaultSeq ?? 0,
      },
    },
  };
};

server.get('/health', healthResponse);
server.get('/api/health', healthResponse);

// ============================================================================
// Admin Notifications API
// ============================================================================

// List all notifications (most recent first)
// Optional filters: ?acknowledged=true|false&category=billing
server.get('/api/notifications', async (request, reply) => {
  const query = validate(notificationListQuerySchema, request.query, reply);
  if (!query) return;

  const limit = query.limit ?? 100;

  // Build WHERE conditions
  const conditions = [];
  if (query.acknowledged === 'false') {
    conditions.push(eq(adminNotifications.acknowledged, false));
  } else if (query.acknowledged === 'true') {
    conditions.push(eq(adminNotifications.acknowledged, true));
  }
  if (query.category) {
    conditions.push(eq(adminNotifications.category, query.category));
  }

  const notifications = await db
    .select()
    .from(adminNotifications)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(adminNotifications.createdAt))
    .limit(limit);

  return {
    notifications: notifications.map((n) => ({
      ...n,
      details: n.details ? JSON.parse(n.details) : null,
    })),
    count: notifications.length,
  };
});

// Get notification counts by severity and category (unacknowledged only)
server.get('/api/notifications/counts', async () => {
  const notifications = await db
    .select({
      severity: adminNotifications.severity,
      category: adminNotifications.category,
    })
    .from(adminNotifications)
    .where(eq(adminNotifications.acknowledged, false));

  const counts: {
    total: number;
    error: number;
    warning: number;
    info: number;
    byCategory: Record<string, number>;
  } = {
    total: notifications.length,
    error: 0,
    warning: 0,
    info: 0,
    byCategory: {},
  };

  for (const n of notifications) {
    if (n.severity === 'error') counts.error++;
    else if (n.severity === 'warning') counts.warning++;
    else if (n.severity === 'info') counts.info++;

    counts.byCategory[n.category] = (counts.byCategory[n.category] ?? 0) + 1;
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

// Acknowledge all unacknowledged notifications (optionally scoped to a category)
server.post('/api/notifications/acknowledge-all', async (request, reply) => {
  const query = validate(acknowledgeAllQuerySchema, request.query, reply);
  if (!query) return;

  const conditions = [eq(adminNotifications.acknowledged, false)];
  if (query.category) {
    conditions.push(eq(adminNotifications.category, query.category));
  }

  const result = await db
    .update(adminNotifications)
    .set({
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: 'admin',
    })
    .where(and(...conditions))
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

  // Get process info for service stability tests
  // Tests capture PID at start and verify it hasn't changed at end
  // to detect unexpected service restarts during test execution
  server.get('/api/test/process-info', async () => {
    return {
      service: 'global-manager',
      pid: process.pid,
      uptime: process.uptime(),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    };
  });

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

  // NOTE: DB truncation has been moved to sudob (/api/test/reset-all)
  // sudob owns ALL destructive test operations and does truncation directly via pg.
  // This keeps dangerous operations in one place (sudob, which never runs in production).
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
 * Loaded from server_configs.py via @mhaxbe/server-configs (data_tx field).
 */
const configuredVaultTypes = getGlobalVaultTypes() as VaultType[];

// Get vault status from data_tx (versions from disk, entries from DB)
server.get('/api/vault/status', async () => {
  const { createVaultReader } = await import('@mhaxbe/vault-codec');

  const reader = createVaultReader({
    storageDir: '/opt/syncf/data_tx',
  });

  // Get entry counts from DB (stored transactionally during vault generation)
  const [control] = await db
    .select()
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  // Map vault type to entries column
  const entriesFromDb: Record<string, number> = {
    sma: control?.smaVaultEntries ?? 0,
    smk: control?.smkVaultEntries ?? 0,
    smo: control?.smoVaultEntries ?? 0,
    sta: control?.staVaultEntries ?? 0,
    stk: control?.stkVaultEntries ?? 0,
    sto: control?.stoVaultEntries ?? 0,
    skk: control?.skkVaultEntries ?? 0,
  };

  // Get status for configured vault types (from server_configs.py data_tx field)
  const vaults: Record<string, {
    vaultType: string;
    latest: { seq: number; pg: number; filename: string } | null;
    previous: { seq: number; pg: number; filename: string } | null;
    allVersions: Array<{ seq: number; pg: number; filename: string }>;
    entries: number;
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
        entries: entriesFromDb[vaultType] ?? 0,
      };
    } catch {
      vaults[vaultType] = {
        vaultType,
        latest: null,
        previous: null,
        allVersions: [],
        entries: 0,
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
    entries: number;
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
          entries: number;
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
        entries: v.entries,
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

// Get fleet-wide sync overview (per vault type)
server.get('/api/sync/overview', async () => {
  const { getLMStatuses } = await import('./tasks/poll-lm-status.js');
  const { systemControl } = await import('@suiftly/database');
  const { eq } = await import('drizzle-orm');

  // Get current vault seqs from system_control
  const [control] = await db
    .select()
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  // Build per-vault-type sync status
  const vaultTypes = [
    { code: 'sma', seq: control?.smaVaultSeq ?? 0, hash: control?.smaVaultContentHash ?? null },
    { code: 'smk', seq: control?.smkVaultSeq ?? 0, hash: control?.smkVaultContentHash ?? null },
    { code: 'smo', seq: control?.smoVaultSeq ?? 0, hash: control?.smoVaultContentHash ?? null },
    { code: 'sta', seq: control?.staVaultSeq ?? 0, hash: control?.staVaultContentHash ?? null },
    { code: 'stk', seq: control?.stkVaultSeq ?? 0, hash: control?.stkVaultContentHash ?? null },
    { code: 'sto', seq: control?.stoVaultSeq ?? 0, hash: control?.stoVaultContentHash ?? null },
    { code: 'skk', seq: control?.skkVaultSeq ?? 0, hash: control?.skkVaultContentHash ?? null },
  ];

  // Get LM statuses (now multiple rows per LM — one per vault type)
  const lmStatuses = await getLMStatuses();
  const recentThreshold = new Date(Date.now() - 30000);

  // Count unique reachable LMs (by lmId, not by row)
  const reachableLmIds = new Set<string>();
  const allLmIds = new Set<string>();
  for (const s of lmStatuses) {
    allLmIds.add(s.lmId);
    if (s.lastSeenAt && s.lastSeenAt > recentThreshold && !s.lastError) {
      reachableLmIds.add(s.lmId);
    }
  }

  // Build per-vault sync info
  const vaults: Record<string, {
    currentSeq: number;
    contentHash: string | null;
    minAppliedSeq: number | null;
    synced: boolean;
  }> = {};

  // Compute min applied seq per vault type from already-fetched LM statuses
  // (avoids N+1 queries — one per vault type)
  const minAppliedSeqByVault = new Map<string, number>();
  for (const s of lmStatuses) {
    if (!s.vaultType || !s.appliedSeq || s.appliedSeq <= 0) continue;
    if (!s.lastSeenAt || s.lastSeenAt <= recentThreshold) continue;
    if (s.lastError) continue;
    const current = minAppliedSeqByVault.get(s.vaultType);
    if (current === undefined || s.appliedSeq < current) {
      minAppliedSeqByVault.set(s.vaultType, s.appliedSeq);
    }
  }

  let allVaultsSynced = true;

  for (const vt of vaultTypes) {
    // Skip vault types with seq 0 (never generated)
    if (vt.seq === 0) continue;

    const minSeq = minAppliedSeqByVault.get(vt.code) ?? null;
    const synced = minSeq !== null && minSeq >= vt.seq;
    if (!synced) allVaultsSynced = false;

    vaults[vt.code] = {
      currentSeq: vt.seq,
      contentHash: vt.hash,
      minAppliedSeq: minSeq,
      synced,
    };
  }

  return {
    vaults,
    lms: {
      total: allLmIds.size,
      reachable: reachableLmIds.size,
      statuses: lmStatuses.map(s => {
        const isReachable = s.lastSeenAt && s.lastSeenAt > recentThreshold && !s.lastError;
        return {
          id: s.lmId,
          name: s.displayName,
          host: s.host,
          region: s.region,
          vaultType: s.vaultType,
          reachable: isReachable,
          appliedSeq: s.appliedSeq,
          processingSeq: s.processingSeq,
          entries: s.entries,
          lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
          lastError: s.lastError,
        };
      }),
    },
    syncStatus: allVaultsSynced ? 'synced' : 'pending',
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
// Billing Monitor API (for Admin Dashboard BillingMonitor page)
// ============================================================================

// Zod schemas for billing endpoints
const billingMonthQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM format').optional(),
  status: z.enum(['all', 'paid', 'pending', 'failed', 'draft', 'voided']).optional().default('all'),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().min(1).max(500)).optional(),
  offset: z.string().regex(/^\d+$/).transform(Number).optional(),
});

/**
 * Classify a billing record into a display bin for the admin UI.
 * Maps DB status + sub-conditions to a human-readable category.
 */
function classifyInvoiceBin(record: {
  status: string;
  paymentActionUrl: string | null;
  retryCount: number | null;
}): { displayBin: string; color: string } {
  switch (record.status) {
    case 'draft':
      return { displayBin: 'Projected', color: 'gray' };
    case 'pending':
      if (record.paymentActionUrl) {
        return { displayBin: 'Awaiting 3DS', color: 'amber' };
      }
      return { displayBin: 'Processing', color: 'blue' };
    case 'failed': {
      const retries = record.retryCount ?? 0;
      if (retries >= 3) {
        return { displayBin: 'Failed (exhausted)', color: 'red' };
      }
      return { displayBin: 'Retrying', color: 'amber' };
    }
    case 'paid':
      return { displayBin: 'Paid', color: 'green' };
    case 'void':
    case 'cancelled':
      return { displayBin: 'Voided', color: 'gray' };
    default:
      return { displayBin: record.status, color: 'gray' };
  }
}

/**
 * Get the start/end timestamps for a billing month (YYYY-MM).
 * Returns UTC boundaries for the month.
 */
function getMonthBounds(monthStr: string): { start: Date; end: Date } {
  const [yearStr, monStr] = monthStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monStr, 10); // 1-indexed
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1)); // first day of next month
  return { start, end };
}

/**
 * Get the current billing month as YYYY-MM string (UTC).
 */
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get the previous billing month as YYYY-MM string (UTC).
 */
function getPreviousMonth(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Helper to aggregate billing records into status bins
async function aggregateMonthBins(monthStr: string) {
  const { start, end } = getMonthBounds(monthStr);

  const records = await db
    .select({
      status: billingRecords.status,
      retryCount: billingRecords.retryCount,
      paymentActionUrl: billingRecords.paymentActionUrl,
      amountUsdCents: billingRecords.amountUsdCents,
    })
    .from(billingRecords)
    .where(
      and(
        gte(billingRecords.billingPeriodStart, start),
        lt(billingRecords.billingPeriodStart, end)
      )
    );

  const bins = {
    paid: { count: 0, totalCents: 0 },
    pending: { count: 0, totalCents: 0 },
    retrying: { count: 0, totalCents: 0 },
    failedExhausted: { count: 0, totalCents: 0 },
    awaiting3ds: { count: 0, totalCents: 0 },
    draft: { count: 0, totalCents: 0 },
    voided: { count: 0, totalCents: 0 },
  };

  for (const r of records) {
    const { displayBin } = classifyInvoiceBin(r);
    const amount = Number(r.amountUsdCents);
    switch (displayBin) {
      case 'Paid': bins.paid.count++; bins.paid.totalCents += amount; break;
      case 'Processing': bins.pending.count++; bins.pending.totalCents += amount; break;
      case 'Retrying': bins.retrying.count++; bins.retrying.totalCents += amount; break;
      case 'Failed (exhausted)': bins.failedExhausted.count++; bins.failedExhausted.totalCents += amount; break;
      case 'Awaiting 3DS': bins.awaiting3ds.count++; bins.awaiting3ds.totalCents += amount; break;
      case 'Projected': bins.draft.count++; bins.draft.totalCents += amount; break;
      case 'Voided': bins.voided.count++; bins.voided.totalCents += amount; break;
    }
  }

  return bins;
}

// GET /api/billing/overview — Summary statistics for billing health
server.get('/api/billing/overview', async (_request, reply) => {
  try {
    const currentMonth = getCurrentMonth();
    const previousMonth = getPreviousMonth();

    // Aggregate bins for both months in parallel
    const [currentBins, previousBins] = await Promise.all([
      aggregateMonthBins(currentMonth),
      aggregateMonthBins(previousMonth),
    ]);

    // Customer statistics
    const allCustomers = await db
      .select({
        customerId: customers.customerId,
        status: customers.status,
        gracePeriodStart: customers.gracePeriodStart,
        paidOnce: customers.paidOnce,
      })
      .from(customers);

    const paymentMethodCount = await db
      .select({ customerId: customerPaymentMethods.customerId })
      .from(customerPaymentMethods)
      .where(eq(customerPaymentMethods.status, 'active'))
      .groupBy(customerPaymentMethods.customerId);

    // Count refund records for current month
    const { start: refundStart, end: refundEnd } = getMonthBounds(currentMonth);
    const refundRecords = await db
      .select({ amountUsdCents: billingRecords.amountUsdCents })
      .from(billingRecords)
      .where(
        and(
          eq(billingRecords.type, 'credit'),
          eq(billingRecords.status, 'paid'),
          gte(billingRecords.billingPeriodStart, refundStart),
          lt(billingRecords.billingPeriodStart, refundEnd),
          sql`${billingRecords.failureReason} LIKE 'refund_of:%'`
        )
      );

    // Count failed refund attempts from admin notifications (code=STRIPE_REFUND_FAILED).
    // Successful refunds show in recentRefunds above, but failed ones only exist as
    // notifications — surfacing the count here gives a complete picture.
    const [refundFailureCount] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(adminNotifications)
      .where(
        and(
          eq(adminNotifications.code, 'STRIPE_REFUND_FAILED'),
          eq(adminNotifications.acknowledged, false)
        )
      );

    return {
      currentMonth: { label: currentMonth, ...currentBins },
      previousMonth: { label: previousMonth, ...previousBins },
      customers: {
        total: allCustomers.length,
        inGracePeriod: allCustomers.filter(c => c.gracePeriodStart !== null).length,
        suspended: allCustomers.filter(c => c.status === 'suspended').length,
        withPaymentMethod: paymentMethodCount.length,
      },
      recentRefunds: {
        count: refundRecords.length,
        totalCents: refundRecords.reduce((sum, r) => sum + Number(r.amountUsdCents), 0),
      },
      refundFailures: {
        count: Number(refundFailureCount?.count ?? 0),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Billing Monitor] /api/billing/overview failed:', err);
    try {
      await logAdminNotificationDedup({
        severity: 'error',
        category: 'billing',
        code: 'BILLING_MONITOR_OVERVIEW_FAILED',
        message: `Billing overview endpoint failed: ${message}`,
        details: { stack: err instanceof Error ? err.stack : undefined },
      });
    } catch { /* don't let notification failure mask the original error */ }
    return reply.status(500).send({ error: 'Failed to load billing overview' });
  }
});

// GET /api/billing/invoices — Paginated invoice list with payment details
server.get('/api/billing/invoices', async (request, reply) => {
  const query = validate(billingMonthQuerySchema, request.query, reply);
  if (!query) return;

  try {
    const monthStr = query.month ?? getCurrentMonth();
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const { start, end } = getMonthBounds(monthStr);

    // Build status filter
    const statusConditions = [];
    statusConditions.push(gte(billingRecords.billingPeriodStart, start));
    statusConditions.push(lt(billingRecords.billingPeriodStart, end));

    if (query.status !== 'all') {
      // Map 'voided' to the DB enum values
      if (query.status === 'voided') {
        statusConditions.push(
          sql`${billingRecords.status} IN ('void', 'cancelled')`
        );
      } else {
        statusConditions.push(eq(billingRecords.status, query.status));
      }
    }

    // Get billing records
    const records = await db
      .select()
      .from(billingRecords)
      .where(and(...statusConditions))
      .orderBy(desc(billingRecords.createdAt))
      .limit(limit)
      .offset(offset);

    if (records.length === 0) {
      return { invoices: [], month: monthStr };
    }

    // Get payment sources and line items for all records in batch
    const recordIds = records.map(r => r.id);
    const [payments, lineItems] = await Promise.all([
      db
        .select()
        .from(invoicePayments)
        .where(sql`${invoicePayments.billingRecordId} IN (${sql.join(recordIds.map(id => sql`${id}`), sql`, `)})`),
      db
        .select()
        .from(invoiceLineItems)
        .where(sql`${invoiceLineItems.billingRecordId} IN (${sql.join(recordIds.map(id => sql`${id}`), sql`, `)})`),
    ]);

    // Group by billing record ID
    const paymentsByRecord = new Map<number, typeof payments>();
    for (const p of payments) {
      const list = paymentsByRecord.get(p.billingRecordId) ?? [];
      list.push(p);
      paymentsByRecord.set(p.billingRecordId, list);
    }

    const lineItemsByRecord = new Map<number, typeof lineItems>();
    for (const li of lineItems) {
      const list = lineItemsByRecord.get(li.billingRecordId) ?? [];
      list.push(li);
      lineItemsByRecord.set(li.billingRecordId, list);
    }

    const invoices = records.map(r => {
      const { displayBin, color } = classifyInvoiceBin(r);
      const rPayments = paymentsByRecord.get(r.id) ?? [];
      const rLineItems = lineItemsByRecord.get(r.id) ?? [];

      return {
        id: r.id,
        customerId: r.customerId,
        amountCents: Number(r.amountUsdCents),
        amountPaidCents: Number(r.amountPaidUsdCents),
        status: r.status,
        displayBin,
        color,
        type: r.type,
        billingType: r.billingType,
        billingPeriodStart: r.billingPeriodStart.toISOString(),
        billingPeriodEnd: r.billingPeriodEnd.toISOString(),
        retryCount: r.retryCount ?? 0,
        lastRetryAt: r.lastRetryAt?.toISOString() ?? null,
        failureReason: r.failureReason,
        paymentActionUrl: r.paymentActionUrl,
        createdAt: r.createdAt.toISOString(),
        paymentSources: rPayments.map(p => ({
          type: p.sourceType,
          amountCents: Number(p.amountUsdCents),
          referenceId: p.providerReferenceId ?? p.escrowTransactionId?.toString() ?? p.creditId?.toString() ?? null,
        })),
        lineItems: rLineItems.map(li => ({
          type: li.itemType,
          serviceType: li.serviceType,
          amountCents: Number(li.amountUsdCents),
          quantity: Number(li.quantity),
          description: li.description,
        })),
      };
    });

    return { invoices, month: monthStr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Billing Monitor] /api/billing/invoices failed:', err);
    try {
      await logAdminNotificationDedup({
        severity: 'error',
        category: 'billing',
        code: 'BILLING_MONITOR_INVOICES_FAILED',
        message: `Billing invoices endpoint failed: ${message}`,
        details: { stack: err instanceof Error ? err.stack : undefined },
      });
    } catch { /* don't let notification failure mask the original error */ }
    return reply.status(500).send({ error: 'Failed to load billing invoices' });
  }
});

// GET /api/alarms — Self-clearing conditions computed from live DB state
// Optional filter: ?category=billing (omit = return all categories)
//
// Unlike notifications (which are persisted and require manual dismiss), alarms
// are re-evaluated from scratch on every request. An alarm appears while its
// underlying condition exists and disappears the moment it resolves — no manual
// action needed. The frontend polls this endpoint on its adaptive interval.
server.get('/api/alarms', async (request, reply) => {
  const query = validate(alarmQuerySchema, request.query, reply);
  if (!query) return;

  try {
    const items = await getAlarmItems(query.category);
    return { items };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Alarms] /api/alarms failed:', err);
    try {
      await logAdminNotificationDedup({
        severity: 'error',
        category: 'system',
        code: 'ALARMS_ENDPOINT_FAILED',
        message: `Alarms endpoint failed: ${message}`,
        details: { category: query.category, stack: err instanceof Error ? err.stack : undefined },
      });
    } catch { /* don't let notification failure mask the original error */ }
    return reply.status(500).send({ error: 'Failed to load alarms' });
  }
});

// GET /api/alarms/counts — Lightweight counts-only for Dashboard polling
server.get('/api/alarms/counts', async (_request, reply) => {
  try {
    const items = await getAlarmItems();
    return countAlarmsByCategory(items);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Alarms] /api/alarms/counts failed:', err);
    try {
      await logAdminNotificationDedup({
        severity: 'error',
        category: 'system',
        code: 'ALARMS_COUNTS_ENDPOINT_FAILED',
        message: `Alarms counts endpoint failed: ${message}`,
        details: { stack: err instanceof Error ? err.stack : undefined },
      });
    } catch { /* don't let notification failure mask the original error */ }
    return reply.status(500).send({ error: 'Failed to load alarm counts' });
  }
});

// Shared alarm item type
interface AlarmItem {
  category: string;
  type: string;
  invoiceId: number | null;
  customerId: number;
  amountCents: number;
  failureReason: string | null;
  retryCount: number;
  lastRetryAt: string | null;
  daysSinceLastRetry: number | null;
  daysSinceCreated: number | null;
  message: string;
}

// Build alarm counts grouped by category
function countAlarmsByCategory(items: AlarmItem[]): Record<string, number> & { total: number } {
  const counts: Record<string, number> & { total: number } = { total: items.length };
  for (const item of items) {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compute all alarm items by querying current DB state.
 *
 * This function is stateless — it runs fresh queries every call and returns
 * whatever conditions currently exist. Nothing is persisted; if the underlying
 * data changes (e.g. an invoice gets paid), the alarm simply won't appear on
 * the next call. The frontend polls on its adaptive interval to pick up changes.
 *
 * @param categoryFilter  When set, only returns alarms for that category
 *                        (skips queries for other categories entirely).
 */
async function getAlarmItems(categoryFilter?: string): Promise<AlarmItem[]> {
  // Currently all alarms are billing — skip if filtering for a different category
  if (categoryFilter && categoryFilter !== 'billing') return [];

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const items: AlarmItem[] = [];

  // 1. Failed + retries exhausted (retryCount >= 3)
  const exhaustedInvoices = await db
    .select()
    .from(billingRecords)
    .where(
      and(
        eq(billingRecords.status, 'failed'),
        gte(billingRecords.retryCount, 3)
      )
    )
    .orderBy(desc(billingRecords.lastRetryAt));

  for (const inv of exhaustedInvoices) {
    const daysSinceRetry = inv.lastRetryAt
      ? Math.floor((now.getTime() - new Date(inv.lastRetryAt).getTime()) / (24 * 60 * 60 * 1000))
      : null;
    const daysSinceCreated = Math.floor((now.getTime() - new Date(inv.createdAt).getTime()) / (24 * 60 * 60 * 1000));
    items.push({
      category: 'billing',
      type: 'failed_exhausted',
      invoiceId: inv.id,
      customerId: inv.customerId,
      amountCents: Number(inv.amountUsdCents),
      failureReason: inv.failureReason,
      retryCount: inv.retryCount ?? 0,
      lastRetryAt: inv.lastRetryAt?.toISOString() ?? null,
      daysSinceLastRetry: daysSinceRetry,
      daysSinceCreated,
      message: `Invoice #${inv.id}: all retries exhausted (${inv.failureReason ?? 'unknown reason'})`,
    });
  }

  // 2. Failed with stalled retries (retryCount < 3 but no recent retry activity).
  // Catches invoices where the processor hiccupped and retries stopped advancing.
  // Also catches legacy rows where lastRetryAt was never set — uses createdAt as fallback.
  const stalledRetries = await db
    .select()
    .from(billingRecords)
    .where(
      and(
        eq(billingRecords.status, 'failed'),
        sql`COALESCE(${billingRecords.retryCount}, 0) < 3`,
        sql`COALESCE(${billingRecords.lastRetryAt}, ${billingRecords.createdAt}) <= ${oneDayAgo}`
      )
    )
    .orderBy(sql`COALESCE(${billingRecords.lastRetryAt}, ${billingRecords.createdAt}) DESC`);

  for (const inv of stalledRetries) {
    const daysSinceRetry = inv.lastRetryAt
      ? Math.floor((now.getTime() - new Date(inv.lastRetryAt).getTime()) / (24 * 60 * 60 * 1000))
      : null;
    const daysSinceCreated = Math.floor((now.getTime() - new Date(inv.createdAt).getTime()) / (24 * 60 * 60 * 1000));
    const sinceLabel = inv.lastRetryAt
      ? `last attempt ${daysSinceRetry}d ago`
      : `created ${daysSinceCreated}d ago, never retried`;
    items.push({
      category: 'billing',
      type: 'failed_stalled',
      invoiceId: inv.id,
      customerId: inv.customerId,
      amountCents: Number(inv.amountUsdCents),
      failureReason: inv.failureReason,
      retryCount: inv.retryCount ?? 0,
      lastRetryAt: inv.lastRetryAt?.toISOString() ?? null,
      daysSinceLastRetry: daysSinceRetry,
      daysSinceCreated,
      message: `Invoice #${inv.id}: failed with ${inv.retryCount ?? 0} retries, ${sinceLabel} — retries may be stalled`,
    });
  }

  // 3. Stale 3DS (pending + paymentActionUrl set for > 7 days)
  const stale3ds = await db
    .select()
    .from(billingRecords)
    .where(
      and(
        eq(billingRecords.status, 'pending'),
        isNotNull(billingRecords.paymentActionUrl),
        lte(billingRecords.createdAt, sevenDaysAgo)
      )
    );

  for (const inv of stale3ds) {
    const daysSinceCreated = Math.floor((now.getTime() - new Date(inv.createdAt).getTime()) / (24 * 60 * 60 * 1000));
    items.push({
      category: 'billing',
      type: 'stale_3ds',
      invoiceId: inv.id,
      customerId: inv.customerId,
      amountCents: Number(inv.amountUsdCents),
      failureReason: null,
      retryCount: 0,
      lastRetryAt: null,
      daysSinceLastRetry: null,
      daysSinceCreated,
      message: `Invoice #${inv.id}: 3DS verification pending for ${daysSinceCreated} days`,
    });
  }

  // 4. Stuck pending invoices (pending, no paymentActionUrl, created > 24h ago).
  // These should have been picked up by the billing processor. If they're still
  // pending after a day, something went wrong (processor hiccup, clock skew, etc.).
  const stuckPending = await db
    .select()
    .from(billingRecords)
    .where(
      and(
        eq(billingRecords.status, 'pending'),
        isNull(billingRecords.paymentActionUrl),
        lte(billingRecords.createdAt, oneDayAgo)
      )
    );

  for (const inv of stuckPending) {
    const daysSince = Math.floor((now.getTime() - new Date(inv.createdAt).getTime()) / (24 * 60 * 60 * 1000));
    items.push({
      category: 'billing',
      type: 'stuck_pending',
      invoiceId: inv.id,
      customerId: inv.customerId,
      amountCents: Number(inv.amountUsdCents),
      failureReason: null,
      retryCount: inv.retryCount ?? 0,
      lastRetryAt: inv.lastRetryAt?.toISOString() ?? null,
      daysSinceLastRetry: null,
      daysSinceCreated: daysSince,
      message: `Invoice #${inv.id}: stuck in pending for ${daysSince} day(s) — processor may have missed it`,
    });
  }

  // 5. Customers in grace period with < 3 days remaining (14-day grace period)
  const graceCustomers = await db
    .select({
      customerId: customers.customerId,
      gracePeriodStart: customers.gracePeriodStart,
    })
    .from(customers)
    .where(isNotNull(customers.gracePeriodStart));

  for (const c of graceCustomers) {
    if (!c.gracePeriodStart) continue;
    const graceEnd = new Date(new Date(c.gracePeriodStart).getTime() + 14 * 24 * 60 * 60 * 1000);
    const daysRemaining = Math.ceil((graceEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    if (daysRemaining <= 3 && daysRemaining >= 0) {
      items.push({
        category: 'billing',
        type: 'grace_expiring',
        invoiceId: null,
        customerId: c.customerId,
        amountCents: 0,
        failureReason: null,
        retryCount: 0,
        lastRetryAt: null,
        daysSinceLastRetry: null,
        daysSinceCreated: null,
        message: `Customer ${c.customerId}: grace period expires in ${daysRemaining} day(s)`,
      });
    }
  }

  return items;
}

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
