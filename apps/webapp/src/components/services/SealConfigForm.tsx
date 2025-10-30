/**
 * Seal Service Configuration Form
 * Phase 10: Service configuration with live pricing
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { sealConfigSchema, type SealConfig, calculateMonthlyFee, SEAL_PRICING } from '@suiftly/shared/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

export function SealConfigForm() {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useForm<SealConfig>({
    resolver: zodResolver(sealConfigSchema),
    defaultValues: {
      tier: 'starter',
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

  const handleTierSelect = (tier: 'starter' | 'pro' | 'enterprise') => {
    setValue('tier', tier);
    // Disable burst if switching to starter
    if (tier === 'starter') {
      setValue('burstEnabled', false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Tier Selection */}
      <Card>
        <CardHeader>
          <CardTitle>Guaranteed Bandwidth</CardTitle>
          <CardDescription>Choose your bandwidth tier</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Starter */}
          <button
            type="button"
            onClick={() => handleTierSelect('starter')}
            className={`
              w-full text-left p-6 rounded-lg border-2 transition-all
              ${formValues.tier === 'starter'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50'
              }
            `}
          >
            <div className="flex justify-between items-start mb-2">
              <h3 className="font-semibold text-lg">STARTER</h3>
              {formValues.tier === 'starter' && (
                <span className="px-3 py-1 bg-primary text-primary-foreground text-xs font-semibold rounded-full">
                  SELECTED
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mb-2">
              100 req/s per region • ~300 req/s globally
            </p>
            <p className="font-semibold">${SEAL_PRICING.tiers.starter.base}/month</p>
          </button>

          {/* Pro */}
          <button
            type="button"
            onClick={() => handleTierSelect('pro')}
            className={`
              w-full text-left p-6 rounded-lg border-2 transition-all
              ${formValues.tier === 'pro'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50'
              }
            `}
          >
            <div className="flex justify-between items-start mb-2">
              <h3 className="font-semibold text-lg">PRO</h3>
              {formValues.tier === 'pro' && (
                <span className="px-3 py-1 bg-primary text-primary-foreground text-xs font-semibold rounded-full">
                  SELECTED
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mb-2">
              1,000 req/s per region • ~3,000 req/s globally
            </p>
            <p className="font-semibold">${SEAL_PRICING.tiers.pro.base}/month</p>
          </button>
        </CardContent>
      </Card>

      {/* Burst */}
      <Card>
        <CardHeader>
          <CardTitle>Burst Capability</CardTitle>
          <CardDescription>Allow temporary traffic spikes beyond guaranteed bandwidth</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="burst"
              checked={formValues.burstEnabled}
              onCheckedChange={(checked) => setValue('burstEnabled', !!checked)}
              disabled={formValues.tier === 'starter'}
            />
            <Label
              htmlFor="burst"
              className={formValues.tier === 'starter' ? 'text-muted-foreground' : ''}
            >
              Enable burst (+${SEAL_PRICING.burst}/month)
              {formValues.tier === 'starter' && ' (Pro/Enterprise only)'}
            </Label>
          </div>
          {errors.burstEnabled && (
            <p className="text-sm text-destructive mt-2">{errors.burstEnabled.message}</p>
          )}
        </CardContent>
      </Card>

      {/* Keys Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Keys & Packages</CardTitle>
          <CardDescription>Configure API keys, Seal keys, and packages</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="sealKeys">Total Seal Keys (1 included)</Label>
            <Input
              id="sealKeys"
              type="number"
              min={1}
              {...register('totalSealKeys', { valueAsNumber: true })}
              className="max-w-xs mt-2"
            />
            <p className="text-xs text-muted-foreground mt-1">
              +${SEAL_PRICING.additionalSealKey}/month per additional key
            </p>
          </div>

          <div>
            <Label htmlFor="packages">Packages Per Seal Key (3 included per key)</Label>
            <Input
              id="packages"
              type="number"
              min={3}
              {...register('packagesPerSealKey', { valueAsNumber: true })}
              className="max-w-xs mt-2"
            />
            <p className="text-xs text-muted-foreground mt-1">
              +${SEAL_PRICING.additionalPackagePerKey}/month per additional package per key
            </p>
          </div>

          <div>
            <Label htmlFor="apiKeys">Total API Keys (1 included)</Label>
            <Input
              id="apiKeys"
              type="number"
              min={1}
              {...register('totalApiKeys', { valueAsNumber: true })}
              className="max-w-xs mt-2"
            />
            <p className="text-xs text-muted-foreground mt-1">
              +${SEAL_PRICING.additionalApiKey}/month per additional key
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Pricing Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="bg-primary/5 rounded-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <span className="text-lg font-semibold">Total Monthly Fee</span>
              <span className="text-3xl font-bold">${monthlyFee.toFixed(2)}</span>
            </div>
            <div className="text-sm text-muted-foreground">
              <p className="font-medium mb-2">Usage Fees (metered separately):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Requests: ${SEAL_PRICING.usageFee.toFixed(2)} per 10,000 requests (all tiers)</li>
              </ul>
            </div>
          </div>

          <Button className="w-full mt-6" size="lg">
            Enable Service
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
