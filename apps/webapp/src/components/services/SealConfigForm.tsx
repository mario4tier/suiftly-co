/**
 * Seal Service Configuration Form
 * Premium design with professional styling
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
import {
  Zap,
  Server,
  Key,
  Package,
  CreditCard,
  Check,
  TrendingUp,
  Shield,
  Clock
} from 'lucide-react';

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
      <div>
        <h3 className="text-base font-semibold text-gray-900 mb-4">Choose your tier</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {/* Starter Tier */}
          <button
            type="button"
            onClick={() => handleTierSelect('starter')}
            className={`
              relative text-left p-6 rounded-lg border-2 transition-all
              ${formValues.tier === 'starter'
                ? 'border-blue-500 bg-blue-50/50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300'
              }
            `}
          >
            {formValues.tier === 'starter' && (
              <div className="absolute top-4 right-4">
                <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
                  <Check className="h-4 w-4 text-white" />
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                <Server className="h-5 w-5 text-gray-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">STARTER</h3>
                <p className="text-xs text-gray-500">Best for small projects</p>
              </div>
            </div>
            <div className="space-y-2 mb-4">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Check className="h-4 w-4 text-green-500" />
                <span>100 req/s per region</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Check className="h-4 w-4 text-green-500" />
                <span>~300 req/s globally</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Check className="h-4 w-4 text-green-500" />
                <span>Standard support</span>
              </div>
            </div>
            <div className="pt-3 border-t border-gray-100">
              <span className="text-2xl font-semibold text-gray-900">${SEAL_PRICING.tiers.starter.base}</span>
              <span className="text-sm text-gray-500">/month</span>
            </div>
          </button>

          {/* Pro Tier */}
          <button
            type="button"
            onClick={() => handleTierSelect('pro')}
            className={`
              relative text-left p-6 rounded-lg border-2 transition-all
              ${formValues.tier === 'pro'
                ? 'border-blue-500 bg-blue-50/50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300'
              }
            `}
          >
            {formValues.tier === 'pro' && (
              <div className="absolute top-4 right-4">
                <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
                  <Check className="h-4 w-4 text-white" />
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">PRO</h3>
                <p className="text-xs text-gray-500">For growing applications</p>
              </div>
            </div>
            <div className="space-y-2 mb-4">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Check className="h-4 w-4 text-green-500" />
                <span>1,000 req/s per region</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Check className="h-4 w-4 text-green-500" />
                <span>~3,000 req/s globally</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Check className="h-4 w-4 text-green-500" />
                <span>Priority support</span>
              </div>
            </div>
            <div className="pt-3 border-t border-gray-100">
              <span className="text-2xl font-semibold text-gray-900">${SEAL_PRICING.tiers.pro.base}</span>
              <span className="text-sm text-gray-500">/month</span>
            </div>
          </button>
        </div>
      </div>

      {/* Additional Options */}
      <div className="grid gap-6 md:grid-cols-2">
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
                  disabled={formValues.tier === 'starter'}
                />
                <Label
                  htmlFor="burst"
                  className={`text-sm ${formValues.tier === 'starter' ? 'text-gray-400' : 'text-gray-700'}`}
                >
                  Enable burst mode
                </Label>
              </div>
              <span className="text-sm font-medium text-gray-900">
                +${SEAL_PRICING.burst}/mo
              </span>
            </div>
            {formValues.tier === 'starter' && (
              <p className="text-xs text-gray-500 mt-2">Available for Pro tier and above</p>
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
      <Card className="border-blue-200 bg-blue-50/30">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-blue-600" />
              <span className="text-sm font-medium text-gray-700">Monthly estimate</span>
            </div>
            <div className="text-right">
              <div className="text-3xl font-semibold text-gray-900">${monthlyFee.toFixed(2)}</div>
              <div className="text-xs text-gray-500">per month</div>
            </div>
          </div>

          <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white" size="lg">
            Enable Service
          </Button>

          <p className="text-xs text-center text-gray-500 mt-4">
            No charges until you enable the service. Cancel anytime.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}