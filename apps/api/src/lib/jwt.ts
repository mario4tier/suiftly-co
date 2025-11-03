/**
 * JWT token generation and verification using jose
 * Based on AUTHENTICATION_DESIGN.md
 *
 * NOTE:
 * config.ts handles loading secrets from ~/.suiftly.env and all validation.
 */

import { SignJWT, jwtVerify } from 'jose';
import { config, systemConfig } from './config';

// Get JWT_SECRET from centralized config
// config.ts has already loaded it from ~/.suiftly.env and validated it
const JWT_SECRET = config.JWT_SECRET;

// Log JWT status (config.ts already validated in production)
if (systemConfig.deploymentType === 'production') {
  console.log('[JWT] ✅ Production mode: JWT_SECRET validated (length: ' + JWT_SECRET.length + ')');
} else {
  console.log('[JWT] Development mode: Using JWT_SECRET from config');
}

const secret = new TextEncoder().encode(JWT_SECRET);

/**
 * JWT payload structure
 */
export interface JwtPayload {
  customerId: number;
  walletAddress: string;
  [key: string]: unknown; // Index signature for jose compatibility
}

import { getJWTConfig } from './jwt-config';

/**
 * Generate access token (configurable expiry - default 15m)
 */
export async function generateAccessToken(payload: JwtPayload): Promise<string> {
  const jwtConfig = getJWTConfig();
  return await new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(jwtConfig.accessTokenExpiry)
    .sign(secret);
}

/**
 * Generate refresh token (configurable expiry - default 30d)
 */
export async function generateRefreshToken(payload: JwtPayload): Promise<string> {
  const jwtConfig = getJWTConfig();
  return await new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(jwtConfig.refreshTokenExpiry)
    .sign(secret);
}

/**
 * Verify and decode JWT token
 */
export async function verifyToken(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, secret);
  return {
    customerId: payload.customerId as number,
    walletAddress: payload.walletAddress as string,
  };
}

/**
 * Verify access token (15 minute expiry)
 */
export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  return await verifyToken(token);
}

/**
 * Verify refresh token (30 day expiry)
 */
export async function verifyRefreshToken(token: string): Promise<JwtPayload> {
  return await verifyToken(token);
}
