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

// Service types
export type ServiceInstance = z.infer<typeof schemas.serviceInstanceSchema>;
export type ServiceCreate = z.infer<typeof schemas.serviceCreateSchema>;
export type ServiceUpdate = z.infer<typeof schemas.serviceUpdateSchema>;
export type ServiceType = z.infer<typeof schemas.serviceTypeSchema>;
export type ServiceTier = z.infer<typeof schemas.serviceTierSchema>;

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
export type UpdateMonthlyLimit = z.infer<typeof schemas.updateMonthlyLimitSchema>;
export type TransactionType = z.infer<typeof schemas.escrowTransactionSchema.shape.txType>;
export type BillingStatus = z.infer<typeof schemas.billingRecordSchema.shape.status>;
