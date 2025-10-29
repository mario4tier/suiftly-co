/**
 * Authentication router
 * Wallet-based authentication with challenge-response flow
 * Based on AUTHENTICATION_DESIGN.md
 */

import { router, publicProcedure } from '../lib/trpc';
import { walletConnectSchema, verifySignatureSchema } from '@suiftly/shared/schemas';
import { generateAccessToken, generateRefreshToken } from '../lib/jwt';
import { db } from '@suiftly/database';
import { customers, authNonces, refreshTokens } from '@suiftly/database/schema';
import { eq, and, gt } from 'drizzle-orm';
import { randomBytes, createHash } from 'crypto';
import { TRPCError } from '@trpc/server';

const MOCK_AUTH = process.env.MOCK_AUTH === 'true';
const NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Step 1: Connect wallet - generates nonce challenge
 */
export const authRouter = router({
  connectWallet: publicProcedure
    .input(walletConnectSchema)
    .mutation(async ({ input }) => {
      const { walletAddress } = input;

      // Generate random nonce (32-byte hex)
      const nonce = randomBytes(32).toString('hex');

      // Store nonce in database (5-minute TTL)
      await db.insert(authNonces).values({
        address: walletAddress,
        nonce,
      })
      .onConflictDoUpdate({
        target: authNonces.address,
        set: {
          nonce,
          createdAt: new Date(),
        },
      });

      console.log(`[AUTH] Nonce generated for ${walletAddress.slice(0, 10)}...`);

      return {
        nonce,
        message: `Sign this message to authenticate: ${nonce}`,
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
        console.log('[AUTH] MOCK MODE: Accepting signature without verification');
      } else {
        // TODO: Real Ed25519 signature verification
        // Will implement with @mysten/sui SDK
        console.log('[AUTH] Real signature verification not yet implemented');
        throw new TRPCError({
          code: 'NOT_IMPLEMENTED',
          message: 'Real signature verification not yet implemented. Set MOCK_AUTH=true',
        });
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
        // New customer - generate random ID
        customerId = Math.floor(Math.random() * 2147483647) + 1;

        await db.insert(customers).values({
          customerId,
          walletAddress,
          status: 'active',
          maxMonthlyUsdCents: 50000, // $500 default from CONSTANTS.md
          currentBalanceUsdCents: 0,
          currentMonthChargedUsdCents: 0,
          lastMonthChargedUsdCents: 0,
          currentMonthStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
        });

        console.log(`[AUTH] New customer created: ${customerId}`);
      } else {
        customerId = customer[0].customerId;
        console.log(`[AUTH] Existing customer: ${customerId}`);
      }

      // Generate JWT tokens
      const payload = { customerId, walletAddress };
      const accessToken = await generateAccessToken(payload);
      const refreshToken = await generateRefreshToken(payload);

      // Store refresh token hash in database
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      await db.insert(refreshTokens).values({
        customerId,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      });

      // Set httpOnly cookie for refresh token
      ctx.res.setCookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
        path: '/',
      });

      console.log(`[AUTH] Tokens issued for customer ${customerId}`);

      return {
        customerId,
        walletAddress,
        accessToken,
        // refreshToken is in httpOnly cookie, not returned
      };
    }),
});
