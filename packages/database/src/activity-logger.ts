import { db } from './db';
import { userActivityLogs } from './schema';
import { desc, eq, sql } from 'drizzle-orm';

export interface ActivityLogEntry {
  customerId: number;
  clientIp: string;
  message: string;
}

/**
 * Log a user activity (login, config change, subscription, etc.)
 * Automatically includes timestamp and client IP
 */
export async function logActivity(entry: ActivityLogEntry): Promise<void> {
  await db.insert(userActivityLogs).values({
    customerId: entry.customerId,
    clientIp: entry.clientIp,
    message: entry.message,
  });

  // Trigger async cleanup (fire and forget)
  // Keep approximately 100 entries per customer
  cleanupOldLogs(entry.customerId).catch(err => {
    console.error('Failed to cleanup activity logs:', err);
  });
}

/**
 * Get paginated activity logs for a customer
 * @param customerId Customer ID
 * @param offset Starting offset (0-based)
 * @param limit Number of entries to return (default 20, max 100)
 * @returns Activity log entries with timestamp and message
 */
export async function getActivityLogs(
  customerId: number,
  offset: number = 0,
  limit: number = 20
) {
  const clampedLimit = Math.min(Math.max(1, limit), 100);

  const logs = await db
    .select({
      id: userActivityLogs.id,
      timestamp: userActivityLogs.timestamp,
      clientIp: userActivityLogs.clientIp,
      message: userActivityLogs.message,
    })
    .from(userActivityLogs)
    .where(eq(userActivityLogs.customerId, customerId))
    .orderBy(desc(userActivityLogs.timestamp))
    .limit(clampedLimit)
    .offset(offset);

  return logs;
}

/**
 * Get total count of activity logs for a customer
 */
export async function getActivityLogCount(customerId: number): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(userActivityLogs)
    .where(eq(userActivityLogs.customerId, customerId));

  return Number(result[0]?.count ?? 0);
}

/**
 * Cleanup old logs, keeping approximately 100 most recent entries per customer
 * This runs asynchronously after each log insert
 */
async function cleanupOldLogs(customerId: number): Promise<void> {
  // Keep 110 entries (gives a buffer before next cleanup)
  const keepCount = 110;

  // Delete entries older than the 110th most recent entry
  await db.execute(sql`
    DELETE FROM ${userActivityLogs}
    WHERE ${userActivityLogs.customerId} = ${customerId}
      AND ${userActivityLogs.id} NOT IN (
        SELECT ${userActivityLogs.id}
        FROM ${userActivityLogs}
        WHERE ${userActivityLogs.customerId} = ${customerId}
        ORDER BY ${userActivityLogs.timestamp} DESC
        LIMIT ${keepCount}
      )
  `);
}
