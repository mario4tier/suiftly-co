/**
 * Main export for @suiftly/shared package
 * Provides validation schemas, types, and constants
 */

// Export constants (no conflicts)
export * from './constants';

// Export schemas (no conflicts)
export * from './schemas';

// Export types with namespace to avoid conflicts with constants
export * as Types from './types';
