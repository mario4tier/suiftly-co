/**
 * Change Tier Modal (Phase 1C)
 *
 * Modal for managing service tier changes and cancellation.
 * Supports:
 * - Tier upgrades (immediate effect with pro-rated charge)
 * - Tier downgrades (scheduled for end of billing period)
 * - Cancellation (scheduled for end of billing period)
 * - Undo cancellation
 *
 * Per BILLING_DESIGN.md R13.
 */

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, Calendar, Loader2, XCircle, Clock } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { formatTierName } from "@/lib/billing-utils";
import type { ServiceType, ServiceTier } from "@suiftly/shared/constants";

interface ChangeTierModalProps {
  isOpen: boolean;
  onClose: () => void;
  serviceType: ServiceType;
  onSuccess?: () => void;
}

export function ChangeTierModal({
  isOpen,
  onClose,
  serviceType,
  onSuccess,
}: ChangeTierModalProps) {
  const [selectedTier, setSelectedTier] = useState<ServiceTier | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    type: 'upgrade' | 'downgrade' | 'cancel';
    tier?: ServiceTier;
  } | null>(null);

  // Reset selected tier when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedTier(null);
    }
  }, [isOpen]);

  const utils = trpc.useUtils();

  // Fetch tier options from API
  const { data: tierOptions, isLoading, error } = trpc.services.getTierOptions.useQuery(
    { serviceType },
    { enabled: isOpen }
  );

  // Mutations
  const upgradeMutation = trpc.services.upgradeTier.useMutation({
    onSuccess: (data) => {
      utils.services.list.invalidate();
      utils.services.getTierOptions.invalidate();
      const chargeText = data.chargeAmountUsdCents > 0
        ? ` You were charged $${(data.chargeAmountUsdCents / 100).toFixed(2)}.`
        : '';
      toast.success(`Upgraded to ${data.newTier.toUpperCase()}.${chargeText}`);
      onSuccess?.();
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to upgrade tier');
    },
  });

  const downgradeMutation = trpc.services.scheduleTierDowngrade.useMutation({
    onSuccess: (data) => {
      utils.services.list.invalidate();
      utils.services.getTierOptions.invalidate();
      // Use paidOnce from tierOptions to determine if change is immediate
      if (!tierOptions?.paidOnce) {
        // Immediate tier change for unpaid subscriptions
        toast.success(`Changed to ${data.scheduledTier.toUpperCase()}`);
      } else {
        // Scheduled downgrade for paid subscriptions
        const effectiveDate = new Date(data.effectiveDate).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        });
        toast.success(`Downgrade to ${data.scheduledTier.toUpperCase()} scheduled for ${effectiveDate}`);
      }
      onSuccess?.();
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to schedule downgrade');
    },
  });

  const cancelMutation = trpc.services.scheduleCancellation.useMutation({
    onSuccess: (data) => {
      utils.services.list.invalidate();
      utils.services.getTierOptions.invalidate();
      // Use paidOnce from tierOptions to determine if change is immediate
      if (!tierOptions?.paidOnce) {
        // Immediate cancellation for unpaid subscriptions
        toast.success(`${serviceType.charAt(0).toUpperCase() + serviceType.slice(1)} subscription cancelled`);
      } else {
        // Scheduled cancellation for paid subscriptions
        const effectiveDate = new Date(data.effectiveDate).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        });
        toast.success(`Cancellation scheduled. Service will end on ${effectiveDate}`);
      }
      onSuccess?.();
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to schedule cancellation');
    },
  });

  const undoCancelMutation = trpc.services.undoCancellation.useMutation({
    onSuccess: () => {
      utils.services.list.invalidate();
      utils.services.getTierOptions.invalidate();
      toast.success('Cancellation undone. Your subscription will continue.');
      onSuccess?.();
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to undo cancellation');
    },
  });

  const cancelScheduledChangeMutation = trpc.services.cancelScheduledTierChange.useMutation({
    onSuccess: () => {
      utils.services.list.invalidate();
      utils.services.getTierOptions.invalidate();
      toast.success('Scheduled tier change cancelled. Continuing with current tier.');
      onSuccess?.();
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to cancel scheduled tier change');
    },
  });

  const isProcessing = upgradeMutation.isPending || downgradeMutation.isPending ||
    cancelMutation.isPending || undoCancelMutation.isPending || cancelScheduledChangeMutation.isPending;

  const handleTierSelect = (tier: ServiceTier) => {
    if (!tierOptions) return;

    const option = tierOptions.availableTiers.find(t => t.tier === tier);
    if (!option || option.isCurrentTier) return;

    setSelectedTier(tier);

    if (option.isUpgrade) {
      setConfirmDialog({ type: 'upgrade', tier });
    } else if (option.isDowngrade) {
      setConfirmDialog({ type: 'downgrade', tier });
    }
  };

  const handleCancelSubscription = () => {
    setConfirmDialog({ type: 'cancel' });
  };

  const handleUndoCancellation = async () => {
    // Direct action - no confirmation needed
    await undoCancelMutation.mutateAsync({ serviceType });
  };

  const handleCancelScheduledChange = async () => {
    // Direct action - no confirmation needed
    await cancelScheduledChangeMutation.mutateAsync({ serviceType });
  };

  const handleConfirm = async () => {
    if (!confirmDialog) return;

    switch (confirmDialog.type) {
      case 'upgrade':
        if (confirmDialog.tier) {
          await upgradeMutation.mutateAsync({
            serviceType,
            newTier: confirmDialog.tier,
          });
        }
        break;
      case 'downgrade':
        if (confirmDialog.tier) {
          await downgradeMutation.mutateAsync({
            serviceType,
            newTier: confirmDialog.tier,
          });
        }
        break;
      case 'cancel':
        await cancelMutation.mutateAsync({ serviceType });
        break;
    }

    setConfirmDialog(null);
  };

  const formatPrice = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC', // Dates are stored as UTC dates, display without timezone shift
    });
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Change Plan</DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : error ? (
            <div className="py-8 text-center text-red-600 dark:text-red-400">
              Failed to load tier options. Please try again.
            </div>
          ) : tierOptions ? (
            <div className="space-y-4 py-4">
              {/* Cancellation Warning */}
              {tierOptions.cancellationScheduled && tierOptions.cancellationEffectiveDate && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                        Cancellation Scheduled
                      </p>
                      <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                        Your subscription will end on {formatDate(tierOptions.cancellationEffectiveDate)}.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 border-amber-600 text-amber-700 hover:bg-amber-100 dark:border-amber-500 dark:text-amber-300 dark:hover:bg-amber-900/30"
                        onClick={handleUndoCancellation}
                        disabled={isProcessing}
                      >
                        Undo Cancellation
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Scheduled Downgrade Warning */}
              {tierOptions.scheduledTier && tierOptions.scheduledTierEffectiveDate && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-4">
                  <div className="flex items-start gap-3">
                    <Clock className="h-5 w-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                        Downgrade Scheduled
                      </p>
                      <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                        Your plan will change to {formatTierName(tierOptions.scheduledTier).toUpperCase()} on {formatDate(tierOptions.scheduledTierEffectiveDate)}.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 border-amber-600 text-amber-700 hover:bg-amber-100 dark:border-amber-500 dark:text-amber-300 dark:hover:bg-amber-900/30"
                        onClick={handleCancelScheduledChange}
                        disabled={isProcessing}
                      >
                        Cancel Scheduled Change
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Tier Options */}
              <div className="space-y-3">
                {tierOptions.availableTiers.map((option) => {
                  const isSelected = selectedTier === option.tier;
                  const isCurrent = option.isCurrentTier;
                  const isScheduled = option.isScheduled;

                  return (
                    <div
                      key={option.tier}
                      onClick={() => !isCurrent && !tierOptions.cancellationScheduled && !isScheduled && handleTierSelect(option.tier as ServiceTier)}
                      className={`
                        relative rounded-lg transition-all border-2 p-4
                        ${isCurrent
                          ? 'border-[#f38020] bg-[#f38020]/5 cursor-default'
                          : isScheduled
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 cursor-default'
                            : tierOptions.cancellationScheduled
                              ? 'border-gray-200 dark:border-gray-700 opacity-50 cursor-not-allowed'
                              : isSelected
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 cursor-pointer'
                                : 'border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 cursor-pointer'
                        }
                      `}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <h4 className="text-base font-bold text-gray-900 dark:text-gray-100">
                              {formatTierName(option.tier as ServiceTier).toUpperCase()}
                            </h4>
                            {isCurrent && (
                              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-[#f38020] text-white">
                                CURRENT
                              </span>
                            )}
                            {isScheduled && (
                              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-600 text-white">
                                SCHEDULED
                              </span>
                            )}
                            {option.isUpgrade && !isCurrent && (
                              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                UPGRADE
                              </span>
                            )}
                            {option.isDowngrade && !isCurrent && !isScheduled && (
                              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                DOWNGRADE
                              </span>
                            )}
                          </div>

                          {/* Pricing info */}
                          <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                            {formatPrice(option.priceUsdCents)}/month
                          </div>

                          {/* Upgrade charge or downgrade info */}
                          {!isCurrent && !tierOptions.cancellationScheduled && (
                            <div className="mt-2 text-xs">
                              {option.isUpgrade && (
                                <span className="text-green-700 dark:text-green-400">
                                  {option.upgradeChargeCents !== undefined && option.upgradeChargeCents > 0
                                    ? `Immediate: ${formatPrice(option.upgradeChargeCents)} pro-rated charge`
                                    : 'Upgrade will take effect immediately'}
                                </span>
                              )}
                              {option.isDowngrade && isScheduled && option.effectiveDate && (
                                <span className="flex items-center gap-1 text-blue-700 dark:text-blue-400">
                                  <Calendar className="h-3 w-3" />
                                  Takes effect {formatDate(option.effectiveDate)}
                                </span>
                              )}
                              {option.isDowngrade && !isScheduled && (
                                <span className="text-gray-500 dark:text-gray-400">
                                  {tierOptions.paidOnce
                                    ? 'Click to schedule downgrade'
                                    : 'Downgrade will take effect immediately'}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Selection indicator */}
                        {isCurrent && (
                          <Check className="h-5 w-5 text-[#f38020]" />
                        )}
                        {isScheduled && (
                          <Clock className="h-5 w-5 text-blue-600 dark:text-blue-500" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Cancel Subscription Button */}
              {!tierOptions.cancellationScheduled && (
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20"
                    onClick={handleCancelSubscription}
                    disabled={isProcessing}
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    Cancel Subscription
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={isProcessing}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog */}
      <AlertDialog open={!!confirmDialog} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDialog?.type === 'upgrade' && 'Confirm Upgrade'}
              {confirmDialog?.type === 'downgrade' && 'Confirm Downgrade'}
              {confirmDialog?.type === 'cancel' && 'Cancel Subscription?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDialog?.type === 'upgrade' && confirmDialog.tier && tierOptions && (
                <>
                  <p>
                    You are upgrading from <strong>{formatTierName(tierOptions.currentTier).toUpperCase()}</strong> to{' '}
                    <strong>{formatTierName(confirmDialog.tier).toUpperCase()}</strong>.
                  </p>
                  {(() => {
                    const option = tierOptions.availableTiers.find(t => t.tier === confirmDialog.tier);
                    if (option?.upgradeChargeCents !== undefined && option.upgradeChargeCents > 0) {
                      return (
                        <p className="mt-2">
                          You will be charged <strong>{formatPrice(option.upgradeChargeCents)}</strong> now
                          (pro-rated for the remaining days in the billing period).
                        </p>
                      );
                    }
                    return null;
                  })()}
                  <p className="mt-2 text-green-700 dark:text-green-400">
                    The upgrade will take effect immediately.
                  </p>
                </>
              )}

              {confirmDialog?.type === 'downgrade' && confirmDialog.tier && tierOptions && (
                <>
                  <p>
                    You are {tierOptions.paidOnce ? 'scheduling a downgrade' : 'changing'} from <strong>{formatTierName(tierOptions.currentTier).toUpperCase()}</strong> to{' '}
                    <strong>{formatTierName(confirmDialog.tier).toUpperCase()}</strong>.
                  </p>
                  {tierOptions.paidOnce ? (
                    (() => {
                      const option = tierOptions.availableTiers.find(t => t.tier === confirmDialog.tier);
                      if (option?.effectiveDate) {
                        return (
                          <p className="mt-2 text-amber-700 dark:text-amber-400">
                            The downgrade will take effect on <strong>{formatDate(option.effectiveDate)}</strong>.
                            You can cancel this change anytime before then.
                          </p>
                        );
                      }
                      return null;
                    })()
                  ) : (
                    <p className="mt-2 text-green-700 dark:text-green-400">
                      The change will take effect immediately.
                    </p>
                  )}
                </>
              )}

              {confirmDialog?.type === 'cancel' && tierOptions && (
                <>
                  {tierOptions.paidOnce ? (
                    // Paid subscription - show full cancellation flow info
                    <>
                      <p>
                        Are you sure you want to cancel your <strong>{formatTierName(tierOptions.currentTier).toUpperCase()}</strong> subscription?
                      </p>
                      <p className="mt-2">
                        Your service will continue until the end of the current billing period.
                        After that, you will have a 7-day grace period before your data is deleted.
                      </p>
                      <p className="mt-2 text-amber-700 dark:text-amber-400">
                        You can undo this cancellation anytime before the billing period ends.
                      </p>
                    </>
                  ) : (
                    // Unpaid subscription - simple immediate cancellation
                    <p>
                      Cancel your <strong>{formatTierName(tierOptions.currentTier).toUpperCase()}</strong> subscription?
                    </p>
                  )}
                </>
              )}

            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={isProcessing}
              className={
                confirmDialog?.type === 'cancel'
                  ? 'bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700'
                  : ''
              }
            >
              {isProcessing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  {confirmDialog?.type === 'upgrade' && 'Confirm Upgrade'}
                  {confirmDialog?.type === 'downgrade' && (tierOptions?.paidOnce ? 'Schedule Downgrade' : 'Confirm Change')}
                  {confirmDialog?.type === 'cancel' && 'Cancel Subscription'}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
