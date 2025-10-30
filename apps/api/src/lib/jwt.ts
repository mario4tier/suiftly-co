/**
 * JWT token generation and verification using jose
 * Based on AUTHENTICATION_DESIGN.md
 */

import { SignJWT, jwtVerify } from 'jose';
import { readFileSync } from 'fs';

/**
 * Read deployment type from walrus system.conf
 * Returns 'production' or 'development'
 */
function getDeploymentType(): string {
  try {
    const configPath = '/etc/walrus/system.conf';
    const config = readFileSync(configPath, 'utf-8');
    const match = config.match(/DEPLOYMENT_TYPE=(\w+)/);
    return match ? match[1] : 'development';
  } catch (error) {
    // If file doesn't exist, assume development
    return 'development';
  }
}

const DEPLOYMENT_TYPE = getDeploymentType();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// CRITICAL SECURITY CHECK: Production must have real JWT_SECRET
if (DEPLOYMENT_TYPE === 'production') {
  if (!process.env.JWT_SECRET) {
    throw new Error(
      'FATAL SECURITY ERROR: JWT_SECRET environment variable not set in production!\n' +
      'Set JWT_SECRET in ~/.env\n' +
      'Generate with: openssl rand -base64 32'
    );
  }

  if (JWT_SECRET === 'dev-secret-change-in-production') {
    throw new Error(
      'FATAL SECURITY ERROR: JWT_SECRET is set to default value in production!\n' +
      'This allows anyone to forge authentication tokens.\n' +
      'Generate a secure secret: openssl rand -base64 32'
    );
  }

  if (JWT_SECRET.length < 32) {
    throw new Error(
      'FATAL SECURITY ERROR: JWT_SECRET must be at least 32 characters (256 bits)\n' +
      'Current length: ' + JWT_SECRET.length + '\n' +
      'Generate a secure secret: openssl rand -base64 32'
    );
  }

  console.log('[JWT] ✅ Production mode: JWT_SECRET validated (length: ' + JWT_SECRET.length + ')');
} else {
  console.log('[JWT] Development mode: Using JWT_SECRET from env or fallback');
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
