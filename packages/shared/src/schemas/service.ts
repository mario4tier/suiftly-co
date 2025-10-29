import { z } from 'zod';
import { SERVICE_TYPE, SERVICE_TIER } from '../constants';

/**
 * Service instance validation schemas
 * Based on service_instances table in CUSTOMER_SERVICE_SCHEMA.md
 */

// Service type enum
export const serviceTypeSchema = z.enum([
  SERVICE_TYPE.SEAL,
  SERVICE_TYPE.GRPC,
  SERVICE_TYPE.GRAPHQL,
]);

// Service tier enum
export const serviceTierSchema = z.enum([
  SERVICE_TIER.STARTER,
  SERVICE_TIER.PRO,
  SERVICE_TIER.ENTERPRISE,
]);

// Seal service configuration (stored in JSONB config column)
export const sealServiceConfigSchema = z.object({
  // Seal-specific settings will go here
  // Example: origins, CORS settings, etc.
}).passthrough(); // Allow additional fields

// Service instance schema
export const serviceInstanceSchema = z.object({
  instanceId: z.string().uuid(),
  customerId: z.number().int().positive(),
  serviceType: serviceTypeSchema,
  tier: serviceTierSchema,
  isEnabled: z.boolean(),
  config: z.record(z.unknown()).nullable().optional(), // JSONB - service-specific
  enabledAt: z.date().or(z.string().datetime()).nullable().optional(),
  disabledAt: z.date().or(z.string().datetime()).nullable().optional(),
});

// Create service schema (for enabling a service)
export const serviceCreateSchema = z.object({
  customerId: z.number().int().positive(),
  serviceType: serviceTypeSchema,
  tier: serviceTierSchema,
  config: z.record(z.unknown()).optional(),
});

// Update service schema (for changing tier or config)
export const serviceUpdateSchema = z.object({
  instanceId: z.string().uuid(),
  tier: serviceTierSchema.optional(),
  config: z.record(z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
});
