/**
 * TypeScript types inferred from Zod schemas
 * These types are automatically kept in sync with validation rules
 */

import { z } from 'zod';
import * as schemas from '../schemas';

// Customer types
export type Customer = z.infer<typeof schemas.customerSchema>;
export type CustomerInsert = z.infer<typeof schemas.customerInsertSchema>;
export type CustomerUpdate = z.infer<typeof schemas.customerUpdateSchema>;
export type CustomerPublic = z.infer<typeof schemas.customerPublicSchema>;
export type CustomerStatus = z.infer<typeof schemas.customerStatusSchema>;

// Service types - reusing existing types from constants
// Note: schemas not yet implemented, using re-exports
export type { ServiceType, ServiceTier } from '../constants';
// export type ServiceInstance = z.infer<typeof schemas.serviceInstanceSchema>;
// export type ServiceCreate = z.infer<typeof schemas.serviceCreateSchema>;
// export type ServiceUpdate = z.infer<typeof schemas.serviceUpdateSchema>;

// API Key types
export type ApiKey = z.infer<typeof schemas.apiKeySchema>;
export type ApiKeyCreate = z.infer<typeof schemas.apiKeyCreateSchema>;
export type ApiKeyResponse = z.infer<typeof schemas.apiKeyResponseSchema>;
export type SealApiKeyMetadata = z.infer<typeof schemas.sealApiKeyMetadataSchema>;

// Auth types
export type WalletConnect = z.infer<typeof schemas.walletConnectSchema>;
export type NonceResponse = z.infer<typeof schemas.nonceResponseSchema>;
export type VerifySignature = z.infer<typeof schemas.verifySignatureSchema>;
export type JwtPayload = z.infer<typeof schemas.jwtPayloadSchema>;
export type AuthResponse = z.infer<typeof schemas.authResponseSchema>;
export type RefreshToken = z.infer<typeof schemas.refreshTokenSchema>;

// Escrow types
export type EscrowTransaction = z.infer<typeof schemas.escrowTransactionSchema>;
export type LedgerEntry = z.infer<typeof schemas.ledgerEntrySchema>;
export type BillingRecord = z.infer<typeof schemas.billingRecordSchema>;
export type DepositRequest = z.infer<typeof schemas.depositRequestSchema>;
export type WithdrawRequest = z.infer<typeof schemas.withdrawRequestSchema>;
// export type UpdateMonthlyLimit = z.infer<typeof schemas.updateMonthlyLimitSchema>;
export type TransactionType = z.infer<typeof schemas.escrowTransactionSchema.shape.txType>;
export type BillingStatus = z.infer<typeof schemas.billingRecordSchema.shape.status>;

// Validation types
export * from './validation';

// Invoice types
import type { ServiceType, InvoiceLineItemType } from '../constants';

/**
 * Structured invoice line item
 *
 * Backend provides structured data; frontend formats display strings.
 * This eliminates brittle description string parsing.
 *
 * The itemType encodes both the charge category AND tier where applicable
 * (e.g., 'subscription_pro' instead of 'tier_subscription' + tier: 'pro')
 */
export interface InvoiceLineItem {
  /** Service this line item belongs to (null for credits, taxes) */
  service: ServiceType | null;

  /** Type of charge (encodes tier for subscriptions, e.g., 'subscription_pro') */
  itemType: InvoiceLineItemType;

  /** Quantity (e.g., number of requests, extra keys, 1 for subscriptions) */
  quantity: number;

  /** Unit price in USD (e.g., $0.0001 per request, $5 per extra key, tier price for subs) */
  unitPriceUsd: number;

  /** Total amount in USD (quantity * unitPriceUsd, negative for credits) */
  amountUsd: number;

  /** Optional: credit month name for credit line items */
  creditMonth?: string;
}
