import { z } from 'zod';
import { SERVICE_TYPE } from '../constants';

/**
 * API Key validation schemas
 * Based on api_keys table in CUSTOMER_SERVICE_SCHEMA.md
 */

// API key fingerprint (4-byte hex, from first 7 Base32 chars)
export const apiKeyFingerprintSchema = z.string()
  .regex(/^[a-f0-9]{8}$/, 'Invalid API key fingerprint (must be 8 hex chars)');

// Seal-specific metadata (stored in JSONB)
export const sealApiKeyMetadataSchema = z.object({
  key_version: z.number().int().min(0).max(3), // 2 bits (0-3)
  seal_network: z.number().int().min(0).max(1), // 0=testnet, 1=mainnet
  seal_access: z.number().int().min(0).max(1), // 0=open, 1=permission
  seal_source: z.number().int().min(0).max(1).nullable(), // 0=derived, 1=imported, null=open
  proc_group: z.number().int().min(0).max(7), // 3 bits (0-7)
});

// Generic API key metadata (service-specific)
export const apiKeyMetadataSchema = z.union([
  sealApiKeyMetadataSchema,
  z.record(z.unknown()), // Other services can define their own
]);

// API key schema
export const apiKeySchema = z.object({
  apiKeyId: z.string().max(100),
  apiKeyFp: apiKeyFingerprintSchema,
  customerId: z.number().int().positive(),
  serviceType: z.enum([SERVICE_TYPE.SEAL, SERVICE_TYPE.GRPC, SERVICE_TYPE.GRAPHQL]),
  metadata: apiKeyMetadataSchema,
  isActive: z.boolean(),
  createdAt: z.date().or(z.string().datetime()),
  revokedAt: z.date().or(z.string().datetime()).nullable().optional(),
});

// Create API key schema
export const apiKeyCreateSchema = z.object({
  customerId: z.number().int().positive(),
  serviceType: z.enum([SERVICE_TYPE.SEAL, SERVICE_TYPE.GRPC, SERVICE_TYPE.GRAPHQL]),
  metadata: apiKeyMetadataSchema.optional(),
});

// API key response (what client receives - never show full key after creation)
export const apiKeyResponseSchema = apiKeySchema.pick({
  apiKeyId: true, // Only shown once at creation
  apiKeyFp: true,
  customerId: true,
  serviceType: true,
  isActive: true,
  createdAt: true,
});
