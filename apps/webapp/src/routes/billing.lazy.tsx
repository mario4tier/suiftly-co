/**
 * Billing Page
 * Shows Suiftly Escrow Account, balance, spending limit, and billing history
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { ChevronRight, ChevronDown, User, ArrowUpDown, ArrowDownUp, Shield, Building2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

export const Route = createLazyFileRoute('/billing')({
  component: BillingPage,
});

function BillingPage() {
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
      setError('Please enter a valid amount greater than 0');
      return;
    }

    try {
      const result = await depositMutation.mutateAsync({
        amountUsd: amount,
      });

      toast.success(`Deposited $${amount.toFixed(2)} successfully`);
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
      setError('Please enter a valid amount greater than 0');
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
      setError('Spending limit must be at least $10 or 0 (unlimited)');
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

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Billing</h2>
        </div>

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
              {!spendingLimit ? 'Unlimited' : `$${spendingLimit.toFixed(2)} per 28-days`}
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <Button variant="outline" onClick={() => setDepositModalOpen(true)}>
            Deposit
          </Button>
          <Button variant="outline" onClick={() => setWithdrawModalOpen(true)}>
            Withdraw
          </Button>
          <Button variant="outline" onClick={() => setSpendingLimitModalOpen(true)}>
            Adjust Spending Limit
          </Button>
        </div>
        <p className="text-xs text-gray-500 mt-3">
          {!found
            ? 'Note: Escrow account will be created on your first deposit'
            : 'Note: Using mock wallet for testing. Real Sui wallet integration coming soon.'}
        </p>
      </Card>

      {/* Current Charges */}
      {found && (
        <>
          <div className="mb-6 space-y-2">
            <div className="flex justify-between py-2">
              <span className="text-gray-600">Pending Per-Request Charges</span>
              <span className="font-medium">$0.00</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-gray-600">
                Last Month Charged ({new Date(new Date().setMonth(new Date().getMonth() - 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})
              </span>
              <span className="font-medium">$0.00</span>
            </div>
          </div>

          {/* Next Scheduled Payment */}
          <Card className="p-4 mb-6">
            <button
              onClick={() => setNextPaymentExpanded(!nextPaymentExpanded)}
              className="w-full flex items-center justify-between text-left"
            >
              <div>
                <div className="font-medium">Next Scheduled Payment</div>
                <div className="text-sm text-gray-500">
                  {new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-bold">$0.00</span>
                {nextPaymentExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            </button>

            {nextPaymentExpanded && (
              <div className="mt-4 pt-4 border-t space-y-2">
                <div className="text-sm text-gray-600">
                  <p className="mb-2 font-medium">Subscription Charges:</p>
                  <p className="ml-4 text-gray-500">No active subscriptions</p>
                </div>
                <div className="text-sm text-gray-600">
                  <p className="mb-2 font-medium">Usage Charges:</p>
                  <p className="ml-4 text-gray-500">No usage charges</p>
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
      <Dialog open={depositModalOpen} onOpenChange={setDepositModalOpen}>
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
            <Button
              variant="outline"
              onClick={() => {
                setDepositModalOpen(false);
                setDepositAmount('');
                setError('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDeposit}
              disabled={depositMutation.isPending || !depositAmount || parseFloat(depositAmount) <= 0 || isNaN(parseFloat(depositAmount))}
            >
              {depositMutation.isPending ? 'Processing...' : 'Deposit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdraw Modal */}
      <Dialog open={withdrawModalOpen} onOpenChange={setWithdrawModalOpen}>
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
            <Button
              variant="outline"
              onClick={() => {
                setWithdrawModalOpen(false);
                setWithdrawAmount('');
                setError('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleWithdraw}
              disabled={withdrawMutation.isPending || !withdrawAmount || parseFloat(withdrawAmount) <= 0 || isNaN(parseFloat(withdrawAmount))}
            >
              {withdrawMutation.isPending ? 'Processing...' : 'Withdraw'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Spending Limit Modal */}
      <Dialog open={spendingLimitModalOpen} onOpenChange={setSpendingLimitModalOpen}>
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
            <Button
              variant="outline"
              onClick={() => {
                setSpendingLimitModalOpen(false);
                setNewSpendingLimitInput('');
                setError('');
              }}
            >
              Cancel
            </Button>
            <Button
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
            </Button>
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
  txHash: string | null;
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
          {transaction.txHash && (
            <div className="flex gap-2">
              <span className="text-gray-500">TX:</span>
              <span className="font-mono text-xs break-all">{transaction.txHash}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
