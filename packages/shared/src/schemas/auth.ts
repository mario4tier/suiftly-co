import { z } from 'zod';

/**
 * Authentication validation schemas
 * Based on AUTHENTICATION_DESIGN.md and auth tables
 */

// Wallet connect request
export const walletConnectSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid Sui wallet address'),
});

// Nonce response
export const nonceResponseSchema = z.object({
  nonce: z.string().min(32), // Random challenge string
  expiresAt: z.string().datetime(),
});

// Signature verification request
export const verifySignatureSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  signature: z.string(), // Base64 encoded signature
  nonce: z.string(),
});

// JWT payload
export const jwtPayloadSchema = z.object({
  customerId: z.number().int().positive(),
  walletAddress: z.string(),
  iat: z.number(), // Issued at
  exp: z.number(), // Expires at
});

// Auth response (after successful verification)
export const authResponseSchema = z.object({
  walletAddress: z.string(),
  accessToken: z.string(), // 15-minute token
  // customerId is internal only (in JWT payload, not sent to client)
  // refreshToken is httpOnly cookie, not returned in JSON
});

// Refresh token schema
export const refreshTokenSchema = z.object({
  id: z.number().int(),
  customerId: z.number().int().positive(),
  tokenHash: z.string().length(64), // SHA256 hash
  expiresAt: z.date().or(z.string().datetime()),
  createdAt: z.date().or(z.string().datetime()),
});
