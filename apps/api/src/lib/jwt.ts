/**
 * JWT token generation and verification using jose
 * Based on AUTHENTICATION_DESIGN.md
 */

import { SignJWT, jwtVerify } from 'jose';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const secret = new TextEncoder().encode(JWT_SECRET);

/**
 * JWT payload structure
 */
export interface JwtPayload {
  customerId: number;
  walletAddress: string;
  [key: string]: unknown; // Index signature for jose compatibility
}

/**
 * Generate access token (15 minutes)
 */
export async function generateAccessToken(payload: JwtPayload): Promise<string> {
  return await new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

/**
 * Generate refresh token (30 days)
 */
export async function generateRefreshToken(payload: JwtPayload): Promise<string> {
  return await new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
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
