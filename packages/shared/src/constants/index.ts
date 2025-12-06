/**
 * System Constants - Single Source of Truth
 *
 * All system-wide constants defined here to prevent documentation drift.
 * See docs/CONSTANTS.md for detailed explanations.
 *
 * IMPORTANT: Enum types are derived from database schema (PostgreSQL ENUM types).
 * See docs/ENUM_IMPLEMENTATION.md for the complete enum architecture.
 */

// Re-export enum types from database package (single source of truth)
export type {
  CustomerStatus,
  ServiceType,
  ServiceState,
  ServiceTier,
  TransactionType,
  BillingStatus,
  InvoiceLineItemType
} from '@suiftly/database/schema';

// Import types for creating constants objects with type checking
import type {
  CustomerStatus,
  ServiceType,
  ServiceState,
  ServiceTier,
  TransactionType,
  BillingStatus,
  InvoiceLineItemType
} from '@suiftly/database/schema';

// 28-Day Spending Limits (Rolling period from account creation)
export const SPENDING_LIMIT = {
  DEFAULT_USD: 250,
  MINIMUM_USD: 10,
  MAXIMUM_USD: null, // unlimited
  PERIOD_DAYS: 28,
  PERIOD_MS: 28 * 24 * 60 * 60 * 1000, // 2419200000 milliseconds
} as const;

// Balance Limits
export const BALANCE_LIMITS = {
  MINIMUM_ACTIVE_SERVICES_USD: 50,
} as const;

/**
 * Constants objects for convenient access
 * These are derived from database enums to ensure consistency.
 * The `satisfies` operator ensures type safety without widening types.
 */

// Customer Status Values
export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const satisfies Record<string, CustomerStatus>;

// Service Types
export const SERVICE_TYPE = {
  SEAL: 'seal',
  GRPC: 'grpc',
  GRAPHQL: 'graphql',
} as const satisfies Record<string, ServiceType>;

// Service Type to Database Number Mapping
// Database uses integer IDs for service_type in haproxy_raw_logs
export const SERVICE_TYPE_NUMBER = {
  [SERVICE_TYPE.SEAL]: 1,
  [SERVICE_TYPE.GRPC]: 2,
  [SERVICE_TYPE.GRAPHQL]: 3,
} as const satisfies Record<ServiceType, number>;

// Reverse mapping: number to service type
export const SERVICE_NUMBER_TO_TYPE = {
  1: SERVICE_TYPE.SEAL,
  2: SERVICE_TYPE.GRPC,
  3: SERVICE_TYPE.GRAPHQL,
} as const satisfies Record<number, ServiceType>;

// Service States (6 distinct states - see UI_DESIGN.md)
export const SERVICE_STATE = {
  NOT_PROVISIONED: 'not_provisioned',
  PROVISIONING: 'provisioning', // Reserved for future use - not currently set by backend
  DISABLED: 'disabled',
  ENABLED: 'enabled',
  SUSPENDED_MAINTENANCE: 'suspended_maintenance',
  SUSPENDED_NO_PAYMENT: 'suspended_no_payment',
} as const satisfies Record<string, ServiceState>;

// Service Tiers
export const SERVICE_TIER = {
  STARTER: 'starter',
  PRO: 'pro',
  ENTERPRISE: 'enterprise',
} as const satisfies Record<string, ServiceTier>;

// Transaction Types
export const TRANSACTION_TYPE = {
  DEPOSIT: 'deposit',
  WITHDRAW: 'withdraw',
  CHARGE: 'charge',
  CREDIT: 'credit',
} as const satisfies Record<string, TransactionType>;

// Billing Status (matches billingStatusEnum in schema/enums.ts)
export const BILLING_STATUS = {
  DRAFT: 'draft',       // Pre-computed projection for next billing cycle
  PENDING: 'pending',   // Ready for payment processing
  PAID: 'paid',         // Fully paid
  FAILED: 'failed',     // Charge attempt failed
  VOIDED: 'voided',     // Cancelled (billing error, etc.)
} as const satisfies Record<string, BillingStatus>;

// Invoice Line Item Types
// Used for structured invoice line items instead of parsing description strings
// Item type encodes both the charge category AND tier where applicable
// NOTE: Type is derived from database ENUM (see invoiceLineItemTypeEnum in schema/enums.ts)
export const INVOICE_LINE_ITEM_TYPE = {
  // Tier subscriptions (per service, per tier)
  SUBSCRIPTION_STARTER: 'subscription_starter',
  SUBSCRIPTION_PRO: 'subscription_pro',
  SUBSCRIPTION_ENTERPRISE: 'subscription_enterprise',

  // Tier upgrade (pro-rated charge for remaining days in month)
  TIER_UPGRADE: 'tier_upgrade',

  // Usage-based charges
  REQUESTS: 'requests',                     // Burst traffic charges (quantity = request count)

  // Add-ons (quantity = extra count beyond included)
  EXTRA_API_KEYS: 'extra_api_keys',
  EXTRA_SEAL_KEYS: 'extra_seal_keys',
  EXTRA_ALLOWLIST_IPS: 'extra_allowlist_ips',
  EXTRA_PACKAGES: 'extra_packages',

  // Credits and taxes
  CREDIT: 'credit',                         // Credits/discounts (quantity = 1, negative amount)
  TAX: 'tax',                               // Tax charges (future)
} as const satisfies Record<string, InvoiceLineItemType>;

// Mapping from ServiceTier to subscription line item type
export const TIER_TO_SUBSCRIPTION_ITEM = {
  [SERVICE_TIER.STARTER]: INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER,
  [SERVICE_TIER.PRO]: INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO,
  [SERVICE_TIER.ENTERPRISE]: INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_ENTERPRISE,
} as const satisfies Record<ServiceTier, InvoiceLineItemType>;

// Field Length Limits (matches database VARCHAR constraints)
// Keep in sync: database schema, validation schemas, tests
// See docs/CONSTANTS.md for documentation
export const FIELD_LIMITS = {
  // Sui blockchain identifiers
  SUI_ADDRESS: 66,          // Wallet addresses, package addresses, contract IDs
  SUI_TX_DIGEST: 64,        // Transaction digests/hashes
  SUI_PUBLIC_KEY: 66,       // Public keys

  // API Keys (encrypted storage)
  API_KEY_ID: 150,          // Encrypted: IV:authTag:ciphertext (~102 chars actual)

  // Authentication & Security
  AUTH_NONCE: 64,           // Challenge nonces
  TOKEN_HASH: 64,           // Session token hashes

  // Service identifiers
  SERVICE_TYPE: 20,         // 'seal', 'grpc', 'graphql'
  SERVICE_STATE: 30,        // 'not_provisioned', 'enabled', 'suspended_*', etc.
  SERVICE_TIER: 20,         // 'starter', 'pro', 'enterprise'

  // Status fields
  CUSTOMER_STATUS: 20,      // 'active', 'suspended', 'closed'
  TRANSACTION_TYPE: 20,     // 'deposit', 'withdraw', 'charge', 'credit'
  BILLING_STATUS: 20,       // 'pending', 'paid', 'failed'

  // User-provided names (DNS/Kubernetes compatible - max 64 chars)
  SEAL_KEY_NAME: 64,        // Seal key names
  PACKAGE_NAME: 64,         // Seal package names

  // Business identifiers
  INVOICE_ID: 50,           // Invoice references

  // System versioning
  VAULT_VERSION: 64,        // MA/MM vault version hashes
} as const;

// Usage-Based Pricing (cents per 1000 requests)
// Pricing: $0.0001 per request = 0.01 cents per request = $1.00 per 10,000 requests
// Value stored as: cents per 1000 requests (e.g., 10 = $1.00 per 10,000 requests)
export const USAGE_PRICING_CENTS_PER_1000 = {
  [SERVICE_TYPE.SEAL]: 10,      // 10 cents per 1000 requests = $0.0001/request
  [SERVICE_TYPE.GRPC]: 10,      // Same pricing
  [SERVICE_TYPE.GRAPHQL]: 10,   // Same pricing
} as const satisfies Record<ServiceType, number>;

// Port Allocations - Single source of truth: ~/walrus/PORT_MAP.md
// Short names for convenient use in tests and configs
export const PORT = {
  API: 22700,     // API Server (22700-22703 in production, load balanced)
  WEB: 22710,     // Webapp dev server (Vite)
  GM: 22600,      // Global Manager admin dashboard
  LM: 22610,      // Local Manager (22610-22613 for multi-server dev simulation)
} as const;

// Convenience URLs for tests
export const API_URL = `http://localhost:${PORT.API}`;
export const WEB_URL = `http://localhost:${PORT.WEB}`;
