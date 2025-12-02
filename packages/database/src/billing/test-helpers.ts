/**
 * Test Helpers for Billing Module
 *
 * These exports are ONLY for use in test files.
 * DO NOT import from this module in production code.
 *
 * The `unsafeAsLockedTransaction` function bypasses the locking safety
 * guarantees and should never be used outside of tests.
 */

export { unsafeAsLockedTransaction } from './locking';
