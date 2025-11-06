/**
 * Validation types for API pre-flight checks
 * Used to validate operations before execution
 */

export interface ValidationError {
  code: string;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}

export interface ValidationWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface BalanceInfo {
  current: number;  // USD
  required: number; // USD
  remaining: number; // USD after operation
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
  balance?: BalanceInfo;
}

// Common validation error codes
export const VALIDATION_ERROR_CODES = {
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  SPENDING_LIMIT_EXCEEDED: 'SPENDING_LIMIT_EXCEEDED',
  ALREADY_SUBSCRIBED: 'ALREADY_SUBSCRIBED',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  INVALID_TIER: 'INVALID_TIER',
  INVALID_SERVICE_TYPE: 'INVALID_SERVICE_TYPE',
  BELOW_MINIMUM_BALANCE: 'BELOW_MINIMUM_BALANCE',
} as const;

// Common validation warning codes
export const VALIDATION_WARNING_CODES = {
  LOW_BALANCE_WARNING: 'LOW_BALANCE_WARNING',
  APPROACHING_SPENDING_LIMIT: 'APPROACHING_SPENDING_LIMIT',
} as const;
