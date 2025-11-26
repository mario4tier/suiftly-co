/**
 * Billing Page
 * Shows Suiftly Escrow Account, balance, spending limit, and billing history
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card } from '../components/ui/card';
import { ActionButton } from '../components/ui/action-button';
import { OKButton } from '../components/ui/ok-button';
import { CancelButton } from '../components/ui/cancel-button';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { ChevronRight, ChevronDown, User, ArrowUpDown, ArrowDownUp, Shield, Building2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { getTierPriceUsdCents } from '@suiftly/shared/pricing';

export const Route = createLazyFileRoute('/billing')({
  component: BillingPage,
});

function BillingPage() {
  const utils = trpc.useUtils();
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [nextPaymentExpanded, setNextPaymentExpanded] = useState(false);
  const [howItWorksExpanded, setHowItWorksExpanded] = useState(false);

  // Modal states
  const [depositModalOpen, setDepositModalOpen] = useState(false);
  const [withdrawModalOpen, setWithdrawModalOpen] = useState(false);
  const [spendingLimitModalOpen, setSpendingLimitModalOpen] = useState(false);

  // Form states
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [newSpendingLimitInput, setNewSpendingLimitInput] = useState('');
  const [error, setError] = useState('');

  // Query balance
  const { data: balanceData, isLoading: balanceLoading, refetch: refetchBalance } = trpc.billing.getBalance.useQuery();

  // Query services to check for pending subscriptions
  const { data: services } = trpc.services.list.useQuery();

  // Query next scheduled payment (DRAFT invoice)
  const { data: nextPaymentData, isLoading: nextPaymentLoading } = trpc.billing.getNextScheduledPayment.useQuery();

  // Query transactions (only when history expanded)
  const { data: transactionsData, isLoading: transactionsLoading, refetch: refetchTransactions } = trpc.billing.getTransactions.useQuery(
    { limit: 20, offset: 0 },
    { enabled: historyExpanded }
  );

  // Mutations
  const depositMutation = trpc.billing.deposit.useMutation();
  const withdrawMutation = trpc.billing.withdraw.useMutation();
  const updateSpendingLimitMutation = trpc.billing.updateSpendingLimit.useMutation();

  // Handle deposit
  const handleDeposit = async () => {
    setError('');
    const amount = parseFloat(depositAmount);

    if (isNaN(amount) || amount <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    try {
      const result = await depositMutation.mutateAsync({
        amountUsd: amount,
      });

      toast.success(`Deposited $${amount.toFixed(2)} successfully`);

      // If subscription charges were reconciled, show additional toast and refresh services
      if (result.reconciledCharges && result.reconciledCharges > 0) {
        toast.success(`${result.reconciledCharges} subscription charge${result.reconciledCharges > 1 ? 's' : ''} processed`);
        // Invalidate services to update UI (remove payment pending banners)
        utils.services.list.invalidate();
        // Invalidate next scheduled payment to show updated DRAFT invoice (now includes activated service)
        utils.billing.getNextScheduledPayment.invalidate();
      }

      setDepositModalOpen(false);
      setDepositAmount('');
      refetchBalance();
      if (historyExpanded) {
        refetchTransactions();
      }
    } catch (err: any) {
      setError(err.message || 'Deposit failed');
    }
  };

  // Handle withdraw
  const handleWithdraw = async () => {
    setError('');
    const amount = parseFloat(withdrawAmount);

    if (isNaN(amount) || amount <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    const currentBalance = balanceData?.balanceUsd || 0;
    if (amount > currentBalance) {
      setError(`Insufficient balance. You have $${currentBalance.toFixed(2)} available.`);
      return;
    }

    try {
      const result = await withdrawMutation.mutateAsync({
        amountUsd: amount,
      });

      toast.success(`Withdrew $${amount.toFixed(2)} successfully`);
      setWithdrawModalOpen(false);
      setWithdrawAmount('');
      refetchBalance();
      if (historyExpanded) {
        refetchTransactions();
      }
    } catch (err: any) {
      setError(err.message || 'Withdrawal failed');
    }
  };

  // Handle spending limit update
  const handleUpdateSpendingLimit = async () => {
    setError('');
    const limit = parseFloat(newSpendingLimitInput);

    if (isNaN(limit) || limit < 0) {
      setError('Please enter a valid limit (0 = unlimited)');
      return;
    }

    if (limit > 0 && limit < 10) {
      setError('Spending limit must be at least $10');
      return;
    }

    try {
      const result = await updateSpendingLimitMutation.mutateAsync({
        newLimitUsd: limit,
      });

      const limitText = limit === 0 ? 'unlimited' : `$${limit.toFixed(2)}`;
      toast.success(`Updated spending limit to ${limitText}`);
      setSpendingLimitModalOpen(false);
      setNewSpendingLimitInput('');
      refetchBalance();
    } catch (err: any) {
      setError(err.message || 'Update failed');
    }
  };

  if (balanceLoading) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Billing</h2>
          </div>
          <div className="animate-pulse space-y-4">
            <div className="h-48 bg-gray-200 rounded-lg"></div>
            <div className="h-24 bg-gray-200 rounded-lg"></div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const balance = balanceData?.balanceUsd ?? 0;
  const spendingLimit = balanceData?.spendingLimitUsd; // null = unlimited, number = limit
  const found = balanceData?.found ?? false;

  // Calculate pending subscription charges
  const pendingServices = services?.filter(s => s.subscriptionChargePending) ?? [];
  const totalPendingUsd = pendingServices.reduce((sum, service) => {
    const priceUsdCents = getTierPriceUsdCents(service.tier);
    return sum + (priceUsdCents / 100);
  }, 0);
  const shortfallUsd = Math.max(0, totalPendingUsd - balance);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Billing</h2>
        </div>

        {/* Pending Subscription Notification */}
        {pendingServices.length > 0 && (
          <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-900 rounded-lg px-4 py-3 flex gap-3">
            <AlertCircle className="h-5 w-5 text-orange-600 dark:text-orange-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm text-orange-900 dark:text-orange-200">
                <p className="font-semibold mb-1">Subscription payment pending</p>
                <p>
                  {pendingServices.length === 1 ? (
                    <>
                      Your {pendingServices[0].serviceType.charAt(0).toUpperCase() + pendingServices[0].serviceType.slice(1)} subscription ({pendingServices[0].tier} tier - ${(getTierPriceUsdCents(pendingServices[0].tier) / 100).toFixed(2)}/month) requires payment.
                    </>
                  ) : (
                    <>
                      You have {pendingServices.length} subscriptions requiring payment (total: ${totalPendingUsd.toFixed(2)}/month).
                    </>
                  )}
                  {' '}
                  {shortfallUsd > 0 ? (
                    <>
                      Deposit at least <span className="font-bold">${shortfallUsd.toFixed(2)}</span> to activate {pendingServices.length === 1 ? 'your service' : 'these services'}.
                    </>
                  ) : (
                    <>
                      You have sufficient balance. The charge will be processed automatically.
                    </>
                  )}
                </p>
              </div>
            </div>
          </div>
        )}

      {/* How It Works - Collapsible */}
      <Card className="p-4 mb-6">
        <button
          onClick={() => setHowItWorksExpanded(!howItWorksExpanded)}
          className="w-full flex items-center justify-between text-left"
        >
          <h3 className="text-base font-semibold">How It Works?</h3>
          {howItWorksExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
        </button>

        {howItWorksExpanded && (
          <div className="mt-6 pt-4 border-t space-y-4">
            {/* Escrow Explanation */}
            <div className="flex items-start gap-3 p-4 bg-blue-50 border-l-4 border-blue-600 rounded-r">
              <Shield className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-gray-700">
                <span className="font-semibold">Sui on-chain protection:</span> You deposit to an escrow smart contract. Suiftly charges for usage without accessing your wallet and can't exceed your spending limit.
              </p>
            </div>

            {/* Escrow Account Flow Diagram - Horizontal */}
            <div className="p-6 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-200">
              <div className="flex items-center justify-between gap-4 max-w-4xl mx-auto">
                {/* User */}
                <div className="flex flex-col items-center gap-2">
                  <div className="w-16 h-16 rounded-full bg-blue-600 flex items-center justify-center shadow-lg">
                    <User className="w-8 h-8 text-white" />
                  </div>
                  <div className="text-sm font-semibold text-gray-700">You</div>
                </div>

                {/* Arrows: Deposit/Withdraw + Control */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1">
                    <ArrowUpDown className="w-5 h-5 text-green-600" />
                    <span className="text-xs text-gray-600 font-medium">Deposit / Withdraw</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Shield className="w-5 h-5 text-blue-600" />
                    <span className="text-xs text-gray-600 font-medium">Control Spending Limit (28-days)</span>
                  </div>
                </div>

                {/* Escrow Account */}
                <div className="flex flex-col items-center gap-2">
                  <div className="w-24 h-20 rounded-lg bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center shadow-xl">
                    <div className="text-center">
                      <Shield className="w-10 h-10 text-white mx-auto" />
                      <div className="text-xs text-white font-semibold mt-1">Escrow</div>
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-gray-700 text-center">
                    Suiftly Escrow Account
                    <div className="text-xs text-gray-500 font-normal">(On-Chain)</div>
                  </div>
                </div>

                {/* Arrows: Charge/Refund */}
                <div className="flex items-center gap-1">
                  <ArrowDownUp className="w-5 h-5 text-orange-600" />
                  <span className="text-xs text-gray-600 font-medium">Charge / Refund</span>
                </div>

                {/* Suiftly */}
                <div className="flex flex-col items-center gap-2">
                  <div className="w-16 h-16 rounded-full bg-indigo-600 flex items-center justify-center shadow-lg">
                    <Building2 className="w-8 h-8 text-white" />
                  </div>
                  <div className="text-sm font-semibold text-gray-700">Suiftly</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Suiftly Escrow Account */}
      <Card className="p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Suiftly Escrow Account</h2>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <div className="text-sm text-gray-500">Balance</div>
            <div className="text-2xl font-bold">${balance.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-sm text-gray-500">Spending Limit Protection</div>
            <div className="text-2xl font-bold">
              {spendingLimit == null ? (
                'Unlimited'
              ) : (
                <>
                  ${spendingLimit.toFixed(2)}{' '}
                  <span className="text-sm font-normal">per 28-days</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <ActionButton onClick={() => setDepositModalOpen(true)}>
            Deposit
          </ActionButton>
          <ActionButton onClick={() => setWithdrawModalOpen(true)} disabled={balance === 0}>
            Withdraw
          </ActionButton>
          <ActionButton onClick={() => {
            // Pre-fill with current value (null/undefined means unlimited = 0)
            setNewSpendingLimitInput(spendingLimit != null ? spendingLimit.toString() : '0');
            setSpendingLimitModalOpen(true);
          }}>
            Adjust Spending Limit
          </ActionButton>
        </div>
        <p className="text-xs text-gray-500 mt-3">
          {!found
            ? 'Note: Escrow account will be created on your first deposit'
            : 'Note: Using mock wallet for testing. Real Sui wallet integration coming soon.'}
        </p>
      </Card>

      {/* Next Scheduled Payment */}
      {found && (
        <>
          <Card className="p-4 mb-6">
            <button
              onClick={() => setNextPaymentExpanded(!nextPaymentExpanded)}
              className="w-full flex items-center justify-between text-left"
            >
              <div>
                <div className="font-medium">Next Scheduled Payment</div>
                <div className="text-sm text-gray-500">
                  {nextPaymentData?.dueDate
                    ? new Date(nextPaymentData.dueDate).toLocaleDateString('en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                        timeZone: 'UTC', // Display UTC date as-is, no local conversion
                      })
                    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toLocaleDateString('en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                        timeZone: 'UTC',
                      })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-bold">
                  {nextPaymentLoading ? '...' : `$${(nextPaymentData?.totalUsd ?? 0).toFixed(2)}`}
                </span>
                {nextPaymentExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            </button>

            {nextPaymentExpanded && (
              <div className="mt-4 pt-4 border-t space-y-2">
                <div className="text-sm">
                  {nextPaymentData?.lineItems && nextPaymentData.lineItems.length > 0 ? (
                    <>
                      {nextPaymentData.lineItems.map((item, index) => (
                        <div
                          key={index}
                          className={`flex justify-between mb-1 ${item.amountUsd < 0 ? 'text-green-600' : 'text-gray-600'}`}
                        >
                          <span>{item.description}</span>
                          <span className="font-medium">
                            {item.amountUsd < 0 ? '-' : ''}${Math.abs(item.amountUsd).toFixed(2)}
                          </span>
                        </div>
                      ))}
                      <div className="flex justify-between pt-2 border-t font-bold">
                        <span>Total Charge:</span>
                        <span>${(nextPaymentData?.totalUsd ?? 0).toFixed(2)}</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-gray-500">No upcoming charges</p>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* Billing History */}
          <Card className="p-4">
            <button
              onClick={() => setHistoryExpanded(!historyExpanded)}
              className="w-full flex items-center justify-between text-left mb-2"
            >
              <h2 className="text-lg font-semibold">Billing History</h2>
              {historyExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
            </button>

            {historyExpanded && (
              <div className="mt-4">
                {transactionsLoading ? (
                  <div className="text-center py-8 text-gray-500">Loading history...</div>
                ) : !transactionsData || transactionsData.transactions.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">No billing history yet</div>
                ) : (
                  <div>
                    {transactionsData?.transactions.map((tx) => (
                      <TransactionItem key={tx.id} transaction={tx} />
                    ))}

                    {transactionsData && transactionsData.total > 20 && (
                      <div className="flex justify-between pt-4 mt-4 border-t">
                        <Button variant="outline" size="sm" disabled>
                          ← Previous
                        </Button>
                        <Button variant="outline" size="sm" disabled>
                          Next →
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Deposit Modal */}
      <Dialog
        open={depositModalOpen}
        onOpenChange={(open) => {
          // Prevent closing while mutation is pending
          if (!depositMutation.isPending) {
            setDepositModalOpen(open);
            if (!open) {
              setDepositAmount('');
              setError('');
            }
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deposit Funds</DialogTitle>
            <DialogDescription>
              Add funds to your Suiftly escrow account. Funds are held securely on-chain.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="depositAmount">Amount (USD)</Label>
              <Input
                id="depositAmount"
                type="number"
                step="0.01"
                min="0.01"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleDeposit();
                  }
                }}
                className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
                <AlertCircle className="w-4 h-4" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <DialogFooter>
            <CancelButton
              disabled={depositMutation.isPending}
              onClick={() => {
                setDepositModalOpen(false);
                setDepositAmount('');
                setError('');
              }}
            >
              Cancel
            </CancelButton>
            <OKButton
              onClick={handleDeposit}
              disabled={
                depositMutation.isPending ||
                !depositAmount ||
                isNaN(parseFloat(depositAmount)) ||
                parseFloat(depositAmount) <= 0
              }
            >
              {depositMutation.isPending ? 'Processing...' : 'Deposit'}
            </OKButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdraw Modal */}
      <Dialog
        open={withdrawModalOpen}
        onOpenChange={(open) => {
          // Prevent closing while mutation is pending
          if (!withdrawMutation.isPending) {
            setWithdrawModalOpen(open);
            if (!open) {
              setWithdrawAmount('');
              setError('');
            }
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw Funds</DialogTitle>
            <DialogDescription>
              Withdraw funds from your escrow account back to your wallet.
              <br />
              Available balance: ${balance.toFixed(2)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="withdrawAmount">Amount (USD)</Label>
              <Input
                id="withdrawAmount"
                type="number"
                step="0.01"
                min="0.01"
                max={balance}
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleWithdraw();
                  }
                }}
                className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
                <AlertCircle className="w-4 h-4" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <DialogFooter>
            <CancelButton
              disabled={withdrawMutation.isPending}
              onClick={() => {
                setWithdrawModalOpen(false);
                setWithdrawAmount('');
                setError('');
              }}
            >
              Cancel
            </CancelButton>
            <OKButton
              onClick={handleWithdraw}
              disabled={
                withdrawMutation.isPending ||
                !withdrawAmount ||
                isNaN(parseFloat(withdrawAmount)) ||
                parseFloat(withdrawAmount) <= 0 ||
                parseFloat(withdrawAmount) > balance
              }
            >
              {withdrawMutation.isPending ? 'Processing...' : 'Withdraw'}
            </OKButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Spending Limit Modal */}
      <Dialog
        open={spendingLimitModalOpen}
        onOpenChange={(open) => {
          // Prevent closing while mutation is pending
          if (!updateSpendingLimitMutation.isPending) {
            setSpendingLimitModalOpen(open);
            if (!open) {
              setNewSpendingLimitInput('');
              setError('');
            }
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Spending Limit</DialogTitle>
            <DialogDescription>
              Set a 28-day spending limit to control how much Suiftly can charge.
              <br />
              Enter 0 for unlimited spending.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="spendingLimit">Spending Limit (USD)</Label>
              <Input
                id="spendingLimit"
                type="number"
                step="1"
                min="0"
                value={newSpendingLimitInput}
                onChange={(e) => setNewSpendingLimitInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleUpdateSpendingLimit();
                  }
                }}
                className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <p className="text-xs text-gray-500">
                Minimum: $10 | Enter 0 for unlimited
              </p>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
                <AlertCircle className="w-4 h-4" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <DialogFooter>
            <CancelButton
              disabled={updateSpendingLimitMutation.isPending}
              onClick={() => {
                setSpendingLimitModalOpen(false);
                setNewSpendingLimitInput('');
                setError('');
              }}
            >
              Cancel
            </CancelButton>
            <OKButton
              onClick={handleUpdateSpendingLimit}
              disabled={
                updateSpendingLimitMutation.isPending ||
                !newSpendingLimitInput ||
                isNaN(parseFloat(newSpendingLimitInput)) ||
                parseFloat(newSpendingLimitInput) < 0 ||
                (parseFloat(newSpendingLimitInput) > 0 && parseFloat(newSpendingLimitInput) < 10)
              }
            >
              {updateSpendingLimitMutation.isPending ? 'Updating...' : 'Update Limit'}
            </OKButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      </div>
    </DashboardLayout>
  );
}

interface Transaction {
  id: string;
  type: string;
  amountUsd: number;
  description: string | null;
  txDigest: string | null;
  createdAt: string;
}

function TransactionItem({ transaction }: { transaction: Transaction }) {
  const [expanded, setExpanded] = useState(false);

  const date = new Date(transaction.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const time = new Date(transaction.createdAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="border-b border-gray-200 last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between py-2 px-1 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className="text-sm text-gray-600 w-24 flex-shrink-0">
            {date}
          </div>
          <div className="text-sm capitalize text-gray-700 w-20 flex-shrink-0">
            {transaction.type}
          </div>
          {transaction.description && (
            <div className="text-sm text-gray-500 truncate flex-1 min-w-0">
              {transaction.description}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className={`text-sm font-medium ${transaction.type === 'deposit' || transaction.type === 'credit' ? 'text-green-600' : 'text-red-600'}`}>
            {transaction.type === 'deposit' || transaction.type === 'credit' ? '+' : '-'}${Math.abs(transaction.amountUsd).toFixed(2)}
          </span>
          {expanded ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
        </div>
      </button>

      {expanded && (
        <div className="px-1 pb-3 space-y-1 text-sm text-gray-600">
          <div className="flex gap-2">
            <span className="text-gray-500">Time:</span>
            <span>{date} {time}</span>
          </div>
          {transaction.txDigest && (
            <div className="flex gap-2">
              <span className="text-gray-500">TX:</span>
              <span className="font-mono text-xs break-all">{transaction.txDigest}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
