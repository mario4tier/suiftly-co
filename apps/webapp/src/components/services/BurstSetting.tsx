/**
 * Burst Setting card
 *
 * Toggle for burst traffic with info popover.
 * Shared between gRPC and Seal "More Settings" tabs.
 */

import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Info } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { ServiceTier } from '@suiftly/shared/types';

interface BurstSettingProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  tier: ServiceTier;
}

export function BurstSetting({ checked, onCheckedChange, disabled, tier }: BurstSettingProps) {
  return (
    <div className="rounded-lg border p-4 dark:border-gray-800">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label htmlFor="burst-toggle" className="text-sm font-medium">
            Burst Allowed
          </Label>
          <Popover>
            <PopoverTrigger>
              <Info className="h-4 w-4 text-gray-400" />
            </PopoverTrigger>
            <PopoverContent className="text-sm max-w-xs">
              When enabled, allows temporary traffic bursts beyond guaranteed bandwidth. Burst traffic is billed per-request.
            </PopoverContent>
          </Popover>
        </div>
        <Switch
          id="burst-toggle"
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled || tier === 'starter'}
        />
      </div>
      {tier === 'starter' && (
        <p className="text-xs text-gray-500 mt-2">Available on Pro tier only</p>
      )}
    </div>
  );
}
