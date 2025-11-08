/**
 * System Constants - Single Source of Truth
 *
 * All system-wide constants defined here to prevent documentation drift.
 * See docs/CONSTANTS.md for detailed explanations.
 */

// 28-Day Spending Limits (Rolling period from account creation)
export const SPENDING_LIMIT = {
  DEFAULT_USD: 250,
  MINIMUM_USD: 10,
  MAXIMUM_USD: null, // unlimited
  PERIOD_DAYS: 28,
  PERIOD_MS: 28 * 24 * 60 * 60 * 1000, // 2419200000 milliseconds
} as const;

// Customer Status Values
export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const;

export type CustomerStatus = typeof CUSTOMER_STATUS[keyof typeof CUSTOMER_STATUS];

// Service Types
export const SERVICE_TYPE = {
  SEAL: 'seal',
  GRPC: 'grpc',
  GRAPHQL: 'graphql',
} as const;

export type ServiceType = typeof SERVICE_TYPE[keyof typeof SERVICE_TYPE];

// Service Tiers
export const SERVICE_TIER = {
  STARTER: 'starter',
  PRO: 'pro',
  ENTERPRISE: 'enterprise',
} as const;

export type ServiceTier = typeof SERVICE_TIER[keyof typeof SERVICE_TIER];

// Balance Limits
export const BALANCE_LIMITS = {
  MINIMUM_ACTIVE_SERVICES_USD: 50,
} as const;

// Transaction Types
export const TRANSACTION_TYPE = {
  DEPOSIT: 'deposit',
  WITHDRAW: 'withdraw',
  CHARGE: 'charge',
  CREDIT: 'credit',
} as const;

export type TransactionType = typeof TRANSACTION_TYPE[keyof typeof TRANSACTION_TYPE];

// Billing Status
export const BILLING_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
} as const;

export type BillingStatus = typeof BILLING_STATUS[keyof typeof BILLING_STATUS];

// Service States (6 distinct states - see UI_DESIGN.md)
export const SERVICE_STATE = {
  NOT_PROVISIONED: 'not_provisioned',
  PROVISIONING: 'provisioning', // Reserved for future use - not currently set by backend
  DISABLED: 'disabled',
  ENABLED: 'enabled',
  SUSPENDED_MAINTENANCE: 'suspended_maintenance',
  SUSPENDED_NO_PAYMENT: 'suspended_no_payment',
} as const;

export type ServiceState = typeof SERVICE_STATE[keyof typeof SERVICE_STATE];
