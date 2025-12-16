/**
 * Service Status Indicator Component
 *
 * Shared component for displaying service operational status consistently
 * across dashboard and service pages.
 *
 * Two independent dimensions per CONTROL_PLANE_DESIGN.md:
 * 1. Operational status (color): disabled (grey), config_needed (yellow), up (green), down (red)
 * 2. Propagation status (overlay): "Updating..." appears with any operational status
 */

import { RefreshCw } from 'lucide-react';
import { type OperationalStatus } from '../../hooks/useServicesStatus';

/**
 * Get display properties for operational status
 * All status logic is determined by backend - frontend just displays
 */
export function getStatusDisplay(status: OperationalStatus) {
  switch (status) {
    case 'disabled':
      return {
        dotColor: 'bg-gray-400 dark:bg-gray-500',
        textColor: 'text-gray-600 dark:text-gray-400',
        label: 'Disabled',
      };
    case 'config_needed':
      return {
        dotColor: 'bg-yellow-400 dark:bg-yellow-500',
        textColor: 'text-yellow-600 dark:text-yellow-400',
        label: 'Config Needed',
      };
    case 'up':
      return {
        dotColor: 'bg-green-500 dark:bg-green-400',
        textColor: 'text-green-600 dark:text-green-400',
        label: 'OK',
      };
    case 'down':
      return {
        dotColor: 'bg-red-500 dark:bg-red-400',
        textColor: 'text-red-600 dark:text-red-400',
        label: 'Down',
      };
  }
}

export interface ServiceStatusIndicatorProps {
  /** Operational status from backend */
  operationalStatus?: OperationalStatus;
  /** Whether sync is in progress */
  isSyncing?: boolean;
  /** Fallback enabled state when backend status not yet available */
  fallbackIsEnabled?: boolean;
  /** Size variant: 'sm' for dashboard cards, 'default' for service pages */
  size?: 'sm' | 'default';
  /** Whether to show "Status:" label prefix */
  showLabel?: boolean;
}

/**
 * Service status indicator with dot, text, and optional updating overlay
 *
 * Presentation is identical across all pages - only size may vary.
 */
export function ServiceStatusIndicator({
  operationalStatus,
  isSyncing,
  fallbackIsEnabled,
  size = 'default',
  showLabel = false,
}: ServiceStatusIndicatorProps) {
  // Use backend status if available, otherwise derive from fallback
  const display = operationalStatus
    ? getStatusDisplay(operationalStatus)
    : getStatusDisplay(fallbackIsEnabled ? 'up' : 'disabled');

  const dotSize = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  return (
    <div className="flex items-center gap-2">
      {showLabel && (
        <span className={`${textSize} text-gray-500 dark:text-gray-400`}>Status:</span>
      )}
      {/* Color indicator dot */}
      <span className={`inline-block ${dotSize} rounded-full ${display.dotColor}`} />
      {/* Operational status text */}
      <span className={`${textSize} font-medium ${display.textColor}`}>
        {display.label}
      </span>
      {/* Propagation overlay - independent of operational status */}
      {isSyncing && (
        <span className={`inline-flex items-center gap-1 ${textSize} text-gray-500 dark:text-gray-400`}>
          <RefreshCw className={`${iconSize} animate-spin`} />
          Updating...
        </span>
      )}
    </div>
  );
}
