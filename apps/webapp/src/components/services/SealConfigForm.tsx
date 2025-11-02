/**
 * Seal Service Configuration Form
 * Premium design with professional styling
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { sealConfigSchema, type SealConfig, calculateMonthlyFee, SEAL_PRICING, type ServiceStatus } from '@suiftly/shared/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Zap,
  Server,
  Key,
  Package,
  CreditCard,
  Check,
  CheckCircle,
  TrendingUp,
  Shield,
  Clock,
  Info
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface SealConfigFormProps {
  onTierChange?: (tierSelected: boolean) => void;
  // TODO: This should come from the API
  serviceStatus?: ServiceStatus;
  // TODO: This should come from the API - the current tier if provisioned
  currentTier?: 'basic' | 'pro' | 'business';
}

export function SealConfigForm({ onTierChange, serviceStatus = 'NotProvisioned', currentTier }: SealConfigFormProps) {
  const isProvisioned = serviceStatus !== 'NotProvisioned';
  const isEnabled = serviceStatus === 'Enabled';
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useForm<SealConfig>({
    resolver: zodResolver(sealConfigSchema),
    defaultValues: {
      tier: currentTier || 'pro', // Default to Pro if not provisioned
      burstEnabled: false,
      totalSealKeys: 1,
      packagesPerSealKey: 3,
      totalApiKeys: 1,
    },
  });

  // Watch all form values for live price calculation
  const formValues = watch();

  // Calculate price in real-time
  const monthlyFee = useMemo(() => {
    return calculateMonthlyFee(formValues);
  }, [formValues]);

  const handleTierSelect = (tier: 'basic' | 'pro' | 'business') => {
    setValue('tier', tier);
    // Disable burst if switching to basic
    if (tier === 'basic') {
      setValue('burstEnabled', false);
    }
    // Notify parent that a tier has been selected
    if (onTierChange) {
      onTierChange(true);
    }
  };

  // Determine tier relationship for action buttons
  const tierOrder = { basic: 0, pro: 1, business: 2 };
  const getActionForTier = (tier: 'basic' | 'pro' | 'business') => {
    if (!isProvisioned) {
      return formValues.tier === tier ? 'selected' : null;
    }
    if (currentTier === tier) {
      return 'current';
    }
    if (tierOrder[tier] > tierOrder[currentTier!]) {
      return 'upgrade';
    }
    return 'downgrade';
  };

  return (
    <div className="space-y-4">
      {/* Tier Selection */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Guaranteed Traffic</h3>
          <Popover>
            <PopoverTrigger asChild>
              <button className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                <Info className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Traffic guaranteed to be served sub-second at each region. Traffic exceeding this rate will be considered burst.
              </p>
            </PopoverContent>
          </Popover>
        </div>
        <div className="space-y-2">
          {(['basic', 'pro', 'business'] as const).map((tier) => {
            const action = getActionForTier(tier);
            const tierData = SEAL_PRICING.tiers[tier];
            const isSelected = formValues.tier === tier;

            return (
              <div
                key={tier}
                className={`
                  relative px-4 py-1.5 rounded-[20px] transition-all
                  ${isSelected
                    ? 'border-2 border-[#2563eb] dark:border-[#3b82f6] bg-[#dbeafe] dark:bg-blue-900/20 shadow-sm'
                    : 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
                  }
                `}
              >
                <div className="flex items-center justify-between gap-4">
                  {/* Left column - Tier info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      {isSelected && (
                        <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-500 flex-shrink-0" />
                      )}
                      <span className={`text-sm font-semibold capitalize ${isSelected ? 'text-[rgb(0,81,195)] dark:text-blue-400' : 'text-gray-900 dark:text-gray-100'}`}>
                        {tier}
                      </span>
                      {action === 'current' && (
                        <span className="text-xs px-2 py-0.5 rounded bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 font-medium">
                          Current Service
                        </span>
                      )}
                    </div>
                    <p className={`text-sm m-0 ${isSelected ? 'text-[rgb(0,81,195)] dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
                      {tierData.reqPerSecRegion} req/s per region (~{tierData.reqPerSecGlobal} req/s globally) - {tierData.burstAllowed ? 'Burst Allowed' : 'No Burst'}
                    </p>
                  </div>

                  {/* Right column - Button and Price */}
                  <div className="flex flex-col items-end gap-2 flex-shrink-0 min-w-[100px]">
                    {!isProvisioned && action === 'selected' && (
                      <span className="text-xs px-2 py-0.5 rounded bg-[rgb(0,81,195)]/10 dark:bg-blue-600/20 text-[rgb(0,81,195)] dark:text-blue-400 font-medium">
                        Selected
                      </span>
                    )}
                    {!isProvisioned && action !== 'selected' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleTierSelect(tier)}
                        className="h-8"
                      >
                        Select
                      </Button>
                    )}
                    {isProvisioned && action === 'upgrade' && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {/* TODO: Handle upgrade */}}
                        className="h-8 bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        Upgrade
                      </Button>
                    )}
                    {isProvisioned && action === 'downgrade' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {/* TODO: Handle downgrade */}}
                        className="h-8"
                      >
                        Downgrade
                      </Button>
                    )}
                    <span className={`text-sm font-semibold ${isSelected ? 'text-[rgb(0,81,195)] dark:text-blue-400' : 'text-gray-900 dark:text-gray-100'}`}>
                      ${tierData.base}/mo
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Additional Options */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Burst Capability */}
        <Card className="border-gray-200">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-gray-400" />
              <CardTitle className="text-base">Burst Capability</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Handle traffic spikes beyond your tier limits
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="burst"
                  checked={formValues.burstEnabled}
                  onCheckedChange={(checked) => setValue('burstEnabled', !!checked)}
                  disabled={formValues.tier === 'basic'}
                />
                <Label
                  htmlFor="burst"
                  className={`text-sm ${formValues.tier === 'basic' ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300'}`}
                >
                  Enable burst mode
                </Label>
              </div>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                +${SEAL_PRICING.burst}/mo
              </span>
            </div>
            {formValues.tier === 'basic' && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Available for Pro tier and above</p>
            )}
          </CardContent>
        </Card>

        {/* API Keys */}
        <Card className="border-gray-200">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Key className="h-5 w-5 text-gray-400" />
              <CardTitle className="text-base">API Keys</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Secure access to your infrastructure
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="apiKeys" className="text-sm text-gray-700">
                  Total API Keys
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="apiKeys"
                    type="number"
                    min={1}
                    {...register('totalApiKeys', { valueAsNumber: true })}
                    className="w-20 h-8"
                  />
                  <span className="text-xs text-gray-500">1 included</span>
                </div>
              </div>
              <div className="text-xs text-gray-500">
                +${SEAL_PRICING.additionalApiKey}/mo per additional key
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Seal Keys & Packages */}
      <Card className="border-gray-200">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-gray-400" />
            <CardTitle className="text-base">Storage Configuration</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Configure Seal keys and storage packages
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="sealKeys" className="text-sm text-gray-700">
                Seal Keys
              </Label>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  id="sealKeys"
                  type="number"
                  min={1}
                  {...register('totalSealKeys', { valueAsNumber: true })}
                  className="w-24 h-9"
                />
                <span className="text-xs text-gray-500">1 included</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                +${SEAL_PRICING.additionalSealKey}/mo per additional
              </p>
            </div>

            <div>
              <Label htmlFor="packages" className="text-sm text-gray-700">
                Packages per Key
              </Label>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  id="packages"
                  type="number"
                  min={3}
                  {...register('packagesPerSealKey', { valueAsNumber: true })}
                  className="w-24 h-9"
                />
                <span className="text-xs text-gray-500">3 included</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                +${SEAL_PRICING.additionalPackagePerKey}/mo per additional
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pricing Summary */}
      {!isProvisioned && (
        <Card className="border-blue-200 bg-blue-50/30 dark:border-blue-900 dark:bg-blue-950/20">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Monthly estimate</span>
              </div>
              <div className="text-right">
                <div className="text-3xl font-semibold text-gray-900 dark:text-gray-100">${monthlyFee.toFixed(2)}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">per month</div>
              </div>
            </div>

            <Button
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              size="lg"
              onClick={() => {/* TODO: Handle enable service */}}
            >
              Enable {formValues.tier.charAt(0).toUpperCase() + formValues.tier.slice(1)} Tier - ${monthlyFee.toFixed(2)}/mo
            </Button>

            <p className="text-xs text-center text-gray-500 dark:text-gray-400 mt-4">
              One-time action. No charge until enabled.
            </p>
          </CardContent>
        </Card>
      )}

      {isProvisioned && (
        <Card className="border-gray-200 dark:border-gray-800">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-gray-600 dark:text-gray-400" />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {isEnabled ? 'Current monthly charge' : 'Service paused'}
                </span>
              </div>
              <div className="text-right">
                <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {isEnabled ? `$${monthlyFee.toFixed(2)}` : '$0.00'}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">per month</div>
              </div>
            </div>

            {isEnabled ? (
              <Button
                className="w-full"
                variant="outline"
                size="lg"
                onClick={() => {/* TODO: Handle disable service */}}
              >
                Disable Service
              </Button>
            ) : (
              <Button
                className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                size="lg"
                onClick={() => {/* TODO: Handle re-enable service */}}
              >
                Re-enable Service - ${monthlyFee.toFixed(2)}/mo
              </Button>
            )}

            <p className="text-xs text-center text-gray-500 dark:text-gray-400 mt-4">
              {isEnabled
                ? 'Disabling will stop billing but preserve your configuration.'
                : 'Re-enabling will resume billing with your current configuration.'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}