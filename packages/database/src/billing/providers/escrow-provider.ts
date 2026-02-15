/**
 * Escrow Payment Provider ("Pay with Crypto")
 *
 * Thin wrapper around ISuiService.charge() implementing IPaymentProvider.
 * Extracts the escrow-specific charging logic from processInvoicePayment().
 *
 * Escrow reads escrowContractId and currentBalanceUsdCents from the customers table
 * (not from customer_payment_methods). These fields remain on customers because
 * they're deeply integrated with blockchain sync, balance tracking, and the
 * immutable escrow address model.
 */

import { eq } from 'drizzle-orm';
import type { IPaymentProvider, ProviderChargeParams, ProviderChargeResult, ProviderInfo } from '@suiftly/shared/payment-provider';
import type { ISuiService } from '@suiftly/shared/sui-service';
import type { DatabaseOrTransaction } from '../../db';
import { customers, escrowTransactions } from '../../schema';
import type { DBClock } from '@suiftly/shared/db-clock';

export class EscrowPaymentProvider implements IPaymentProvider {
  readonly type = 'escrow' as const;

  constructor(
    private suiService: ISuiService,
    private db: DatabaseOrTransaction,
    private clock: DBClock,
  ) {}

  async canPay(customerId: number, amountUsdCents: number): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
    if (!customer?.escrowContractId) return false;
    return (customer.currentBalanceUsdCents ?? 0) >= amountUsdCents;
  }

  async isConfigured(customerId: number): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
    return !!customer?.escrowContractId;
  }

  async charge(params: ProviderChargeParams): Promise<ProviderChargeResult> {
    const customer = await this.getCustomer(params.customerId);
    if (!customer) {
      return { success: false, error: 'Customer not found', retryable: false };
    }

    if (!customer.escrowContractId) {
      return { success: false, error: 'No escrow account configured', retryable: false };
    }

    // Charge escrow via ISuiService
    const chargeResult = await this.suiService.charge({
      userAddress: customer.walletAddress,
      amountUsdCents: params.amountUsdCents,
      description: params.description,
      escrowAddress: customer.escrowContractId,
    });

    if (!chargeResult.success || !chargeResult.digest) {
      return {
        success: false,
        error: chargeResult.error ?? 'Escrow charge failed',
        retryable: true,
      };
    }

    // Record escrow transaction
    const txDigest = Buffer.from(chargeResult.digest.replace(/^0x/, ''), 'hex');

    const [escrowTx] = await this.db
      .insert(escrowTransactions)
      .values({
        customerId: params.customerId,
        txDigest,
        txType: 'charge',
        // IMPORTANT: escrow_transactions.amount is DECIMAL (dollars), not cents
        // This matches blockchain format. All other billing tables use cents.
        amount: String(params.amountUsdCents / 100),
        assetType: 'USDC',
        timestamp: this.clock.now(),
      })
      .returning({ id: escrowTransactions.txId });

    return {
      success: true,
      referenceId: String(escrowTx.id),
      txDigest,
      retryable: false,
    };
  }

  async getInfo(customerId: number): Promise<ProviderInfo | null> {
    // Computed LIVE from customers.currentBalanceUsdCents (not cached)
    const customer = await this.getCustomer(customerId);
    if (!customer?.escrowContractId) return null;
    return {
      type: 'escrow',
      displayLabel: `Escrow: $${((customer.currentBalanceUsdCents ?? 0) / 100).toFixed(2)} USDC`,
      details: { balance: customer.currentBalanceUsdCents, walletAddress: customer.walletAddress },
    };
  }

  private async getCustomer(customerId: number) {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.customerId, customerId))
      .limit(1);
    return customer;
  }
}
