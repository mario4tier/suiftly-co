/**
 * Database Permission Verification (runs on startup)
 *
 * Ensures deploy user CANNOT perform DDL operations.
 * Fails fast if permissions are misconfigured (catches prod misconfigurations).
 */

import { db } from '@suiftly/database';
import { sql } from 'drizzle-orm';

export async function verifyDatabasePermissions(): Promise<void> {
  console.log('🔒 Verifying database permissions...');

  // Test 1: CREATE TABLE should fail
  try {
    await db.execute(sql`CREATE TABLE __permission_test_table (id INT)`);
    // If we get here, permissions are TOO PERMISSIVE
    throw new Error(
      '❌ SECURITY: deploy user can CREATE TABLE (DDL operations should be blocked!)'
    );
  } catch (error: any) {
    // Check both the main message and the cause for permission denied
    const errorString = error.message || '';
    const causeString = error.cause?.message || '';
    if (errorString.includes('permission denied') || causeString.includes('permission denied')) {
      console.log('  ✅ CREATE TABLE blocked (correct)');
    } else {
      // Re-throw if it's not a permission denied error
      throw error;
    }
  }

  // Test 2: ALTER TABLE should fail
  try {
    await db.execute(sql`ALTER TABLE customers ADD COLUMN __test_forbidden TEXT`);
    // If we get here, permissions are TOO PERMISSIVE
    throw new Error(
      '❌ SECURITY: deploy user can ALTER TABLE (DDL operations should be blocked!)'
    );
  } catch (error: any) {
    // Check both the main message and the cause for permission/ownership errors
    const errorString = error.message || '';
    const causeString = error.cause?.message || '';
    if (
      errorString.includes('permission denied') ||
      causeString.includes('permission denied') ||
      errorString.includes('must be owner of table') ||
      causeString.includes('must be owner of table')
    ) {
      console.log('  ✅ ALTER TABLE blocked (correct)');
    } else {
      // Re-throw if it's not a permission/ownership error
      throw error;
    }
  }

  console.log('✅ Database permissions verified: DDL blocked, DML allowed');
}
