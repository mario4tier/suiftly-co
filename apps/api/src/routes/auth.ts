/**
 * Authentication router
 * Wallet-based authentication with challenge-response flow
 * Based on AUTHENTICATION_DESIGN.md
 */

import { router, publicProcedure } from '../lib/trpc';
import { walletConnectSchema, verifySignatureSchema } from '@suiftly/shared/schemas';
import { generateAccessToken, generateRefreshToken } from '../lib/jwt';
import { getJWTConfig, parseExpiryToMs } from '../lib/jwt-config';
import { db } from '@suiftly/database';
import { customers, authNonces, refreshTokens } from '@suiftly/database/schema';
import { eq, and, gt } from 'drizzle-orm';
import { randomBytes, createHash } from 'crypto';
import { TRPCError } from '@trpc/server';

const MOCK_AUTH = process.env.MOCK_AUTH === 'true';
const NONCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes (user-friendly, still secure)

/**
 * Step 1: Connect wallet - generates nonce challenge
 */
export const authRouter = router({
  connectWallet: publicProcedure
    .input(walletConnectSchema)
    .mutation(async ({ input }) => {
      const { walletAddress } = input;

      // Check if there's already a valid nonce for this address
      const existingNonce = await db
        .select()
        .from(authNonces)
        .where(eq(authNonces.address, walletAddress))
        .limit(1);

      // If valid nonce exists (< 10 min old), reuse it
      if (existingNonce.length > 0) {
        const age = Date.now() - existingNonce[0].createdAt.getTime();
        if (age < NONCE_EXPIRY_MS) {
          console.log(`[AUTH] Reusing existing nonce for ${walletAddress.slice(0, 10)}... (age: ${Math.floor(age / 1000)}s)`);

          // Build message with existing nonce
          const message = [
            'Sign in to Suiftly',
            '',
            'This approval is only for authentication.',
            'No fund transfer.',
            '',
            existingNonce[0].nonce,
          ].join('\n');

          return {
            nonce: existingNonce[0].nonce,
            message,
            expiresAt: new Date(existingNonce[0].createdAt.getTime() + NONCE_EXPIRY_MS).toISOString(),
          };
        }
      }

      // Generate new nonce (32-byte hex)
      const nonce = randomBytes(32).toString('hex');

      // Delete any old nonce and insert fresh one
      await db.delete(authNonces).where(eq(authNonces.address, walletAddress));
      await db.insert(authNonces).values({
        address: walletAddress,
        nonce,
        createdAt: new Date(),
      });

      console.log(`[AUTH] New nonce generated for ${walletAddress.slice(0, 10)}...`);

      // Clear, reassuring message (nonce embedded but not shown to user)
      const message = [
        'Sign in to Suiftly',
        '',
        'This approval is only for authentication.',
        'No fund transfer.',
        '',
        // Nonce still needed for cryptographic verification (hidden from display)
        nonce,
      ].join('\n');

      return {
        nonce,
        message,
        expiresAt: new Date(Date.now() + NONCE_EXPIRY_MS).toISOString(),
      };
    }),

  /**
   * Step 2: Verify signature and issue JWT tokens
   */
  verifySignature: publicProcedure
    .input(verifySignatureSchema)
    .mutation(async ({ input, ctx }) => {
      const { walletAddress, signature, nonce } = input;

      // Verify nonce exists and not expired
      const nonceRecord = await db
        .select()
        .from(authNonces)
        .where(
          and(
            eq(authNonces.address, walletAddress),
            eq(authNonces.nonce, nonce),
            gt(authNonces.createdAt, new Date(Date.now() - NONCE_EXPIRY_MS))
          )
        )
        .limit(1);

      if (nonceRecord.length === 0) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired nonce',
        });
      }

      // Verify signature
      if (MOCK_AUTH) {
        // Mock mode: Skip cryptographic verification (development only)
      } else {
        // Real Ed25519 signature verification
        // Reconstruct the exact message that was signed
        const message = [
          'Sign in to Suiftly',
          '',
          'This approval is only for authentication.',
          'No fund transfer.',
          '',
          nonce,
        ].join('\n');

        const { verifySuiSignature } = await import('../lib/signature');
        const isValid = await verifySuiSignature(walletAddress, message, signature);

        if (!isValid) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid signature',
          });
        }
      }

      // Delete used nonce (prevent replay)
      await db.delete(authNonces).where(eq(authNonces.address, walletAddress));

      // Find or create customer
      let customer = await db
        .select()
        .from(customers)
        .where(eq(customers.walletAddress, walletAddress))
        .limit(1);

      let customerId: number;

      if (customer.length === 0) {
        // New customer - generate random ID with collision retry
        const MAX_RETRIES = 10;
        let inserted = false;

        for (let attempt = 0; attempt < MAX_RETRIES && !inserted; attempt++) {
          customerId = Math.floor(Math.random() * 2147483647) + 1;

          try {
            await db.insert(customers).values({
              customerId,
              walletAddress,
              status: 'active',
              maxMonthlyUsdCents: 25000, // $250 default from CONSTANTS.md
              currentBalanceUsdCents: 0,
              currentMonthChargedUsdCents: 0,
              lastMonthChargedUsdCents: 0,
              currentMonthStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
            });
            inserted = true;
          } catch (error: any) {
            // Check if it's a primary key collision
            if (error.code === '23505' && error.constraint === 'customers_pkey') {
              // Collision - retry with new ID
              if (attempt === MAX_RETRIES - 1) {
                throw new TRPCError({
                  code: 'INTERNAL_SERVER_ERROR',
                  message: 'Failed to generate unique customer ID after multiple attempts',
                });
              }
              // Continue to next iteration
            } else {
              // Different error - rethrow
              throw error;
            }
          }
        }
      } else {
        customerId = customer[0].customerId;
      }

      // Generate JWT tokens
      const payload = { customerId, walletAddress };
      const accessToken = await generateAccessToken(payload);
      const refreshToken = await generateRefreshToken(payload);

      // Store refresh token hash in database
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      const jwtConfig = getJWTConfig();
      const refreshExpiryMs = parseExpiryToMs(jwtConfig.refreshTokenExpiry);
      console.log('[AUTH] Refresh token expiry:', jwtConfig.refreshTokenExpiry, '=', refreshExpiryMs, 'ms =', Math.floor(refreshExpiryMs / 1000), 'seconds');

      // Delete any existing refresh tokens for this customer (prevent token buildup)
      await db.delete(refreshTokens).where(eq(refreshTokens.customerId, customerId));

      await db.insert(refreshTokens).values({
        customerId,
        tokenHash,
        expiresAt: new Date(Date.now() + refreshExpiryMs),
      });

      // Set httpOnly cookie for refresh token
      ctx.res.setCookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: Math.floor(refreshExpiryMs / 1000), // Convert ms to seconds
        path: '/',
      });

      return {
        // Don't send customer_id to client (internal only)
        walletAddress,
        accessToken,
        // refreshToken is in httpOnly cookie, not returned
      };
    }),

  /**
   * Step 3: Refresh access token using refresh token cookie
   */
  refresh: publicProcedure.mutation(async ({ ctx }) => {
    const refreshToken = ctx.req.cookies.refreshToken;

    if (!refreshToken) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'No refresh token provided',
      });
    }

    try {
      // Verify refresh token
      const { verifyRefreshToken } = await import('../lib/jwt');
      const payload = await verifyRefreshToken(refreshToken);

      // Check if token exists in database (not revoked)
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      const storedToken = await db
        .select()
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.customerId, payload.customerId),
            eq(refreshTokens.tokenHash, tokenHash),
            gt(refreshTokens.expiresAt, new Date())
          )
        )
        .limit(1);

      if (storedToken.length === 0) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Refresh token revoked or expired',
        });
      }

      // Generate new access token
      const accessToken = await generateAccessToken({
        customerId: payload.customerId,
        walletAddress: payload.walletAddress,
      });

      return {
        accessToken,
      };
    } catch (error) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid refresh token',
      });
    }
  }),

  /**
   * Logout: Revoke refresh token
   */
  logout: publicProcedure.mutation(async ({ ctx }) => {
    const refreshToken = ctx.req.cookies.refreshToken;

    if (refreshToken) {
      // Revoke refresh token in database
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));

      console.log('[AUTH] Refresh token revoked');
    }

    // Clear cookie
    ctx.res.clearCookie('refreshToken');

    return { success: true };
  }),
});
