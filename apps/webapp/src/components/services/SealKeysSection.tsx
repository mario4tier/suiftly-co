/**
 * Seal Keys & Packages Management Section
 * Cards showing seal keys with nested packages (always visible)
 */

import { useState } from "react";
import { Download, Ban, Trash2, Plus, Check, X, Pencil, Loader2, CheckCircle, AlertCircle, Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyableValue } from "@/components/ui/copyable-value";
import { InlineButton } from "@/components/ui/inline-button";

type RegistrationStatus = 'registering' | 'registered' | 'updating';

interface SealKey {
  id: string;
  key: string; // Truncated display
  name?: string | null; // User-defined name
  objectId?: string; // Sui object ID (truncated)
  isDisabled: boolean;
  packages: Package[];
  // Registration status fields
  registrationStatus?: RegistrationStatus;
  registrationError?: string | null;
  registrationAttempts?: number;
  nextRetryAt?: Date | string | null;
}

interface Package {
  id: string;
  address: string; // Truncated for display
  fullAddress?: string; // Full address for copying
  name?: string;
  isDisabled: boolean; // Package enable/disable status
}

/**
 * Registration Status Badge
 * Shows the current Sui blockchain registration state of a seal key
 */
function RegistrationStatusBadge({
  status,
  error,
  attempts,
  nextRetryAt,
}: {
  status?: RegistrationStatus;
  error?: string | null;
  attempts?: number;
  nextRetryAt?: Date | string | null;
}) {
  if (!status) return null;

  // Format next retry time for display
  const formatNextRetry = (nextRetry: Date | string | null | undefined): string => {
    if (!nextRetry) return '';
    const date = new Date(nextRetry);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();

    if (diffMs <= 0) return 'retrying soon';

    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);

    if (diffMins > 0) {
      return `retry in ${diffMins}m ${diffSecs % 60}s`;
    }
    return `retry in ${diffSecs}s`;
  };

  // Determine badge content based on status
  const getBadgeContent = () => {
    switch (status) {
      case 'registering':
        return {
          icon: <Loader2 className="h-3 w-3 animate-spin" />,
          text: 'On-chain Registering...',
          bgColor: 'bg-blue-100 dark:bg-blue-900/30',
          textColor: 'text-blue-700 dark:text-blue-400',
          tooltip: 'Registering KeyServer object on Sui blockchain',
        };
      case 'registered':
        return {
          icon: <CheckCircle className="h-3 w-3" />,
          text: 'On-chain Registered',
          bgColor: 'bg-green-100 dark:bg-green-900/30',
          textColor: 'text-green-700 dark:text-green-400',
          tooltip: 'KeyServer object registered on Sui blockchain',
        };
      case 'updating':
        return {
          icon: <Loader2 className="h-3 w-3 animate-spin" />,
          text: 'On-chain Updating...',
          bgColor: 'bg-amber-100 dark:bg-amber-900/30',
          textColor: 'text-amber-700 dark:text-amber-400',
          tooltip: 'Updating KeyServer object on Sui blockchain',
        };
      default:
        return null;
    }
  };

  const badge = getBadgeContent();
  if (!badge) return null;

  // Show error indicator if there's an error during registration/updating
  const hasError = error && (status === 'registering' || status === 'updating');

  // If there's an error, show a popover with details
  if (hasError) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ${badge.bgColor} ${badge.textColor} cursor-help`}
          >
            <AlertCircle className="h-3 w-3" />
            {badge.text}
            <Info className="h-3 w-3" />
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="space-y-2">
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              Registration Error
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {error}
            </p>
            {attempts && attempts > 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Attempt {attempts}{nextRetryAt ? ` • ${formatNextRetry(nextRetryAt)}` : ''}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // Simple badge with title tooltip for non-error states
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded ${badge.bgColor} ${badge.textColor}`}
      title={badge.tooltip}
    >
      {badge.icon}
      {badge.text}
    </span>
  );
}

interface SealKeysSectionProps {
  sealKeys: SealKey[];
  maxSealKeys: number;
  maxPackagesPerKey: number;
  isReadOnly?: boolean;
  onExportKey?: (keyId: string, keyPreview: string, keyName?: string) => void;
  onToggleKey?: (keyId: string, currentlyDisabled: boolean, keyPreview: string, keyName?: string) => void;
  onDeleteKey?: (keyId: string, keyPreview: string, keyName?: string) => void;
  onAddKey?: () => void;
  onAddPackage?: (keyId: string) => void;
  onUpdateSealKeyName?: (keyId: string, newName: string) => void;
  onUpdatePackageName?: (keyId: string, packageId: string, newName: string) => void;
  onEnablePackage?: (keyId: string, packageId: string) => void;
  onDisablePackage?: (keyId: string, packageId: string, packageAddress: string, packageName?: string) => void;
  onDeletePackage?: (keyId: string, packageId: string, packageAddress: string, packageName?: string) => void;
  onCopyObjectId?: (objectId: string) => void;
}

export function SealKeysSection({
  sealKeys,
  maxSealKeys,
  maxPackagesPerKey,
  isReadOnly = false,
  onExportKey,
  onToggleKey,
  onDeleteKey,
  onAddKey,
  onAddPackage,
  onUpdateSealKeyName,
  onUpdatePackageName,
  onEnablePackage,
  onDisablePackage,
  onDeletePackage,
  onCopyObjectId,
}: SealKeysSectionProps) {
  const [editingSealKeyId, setEditingSealKeyId] = useState<string | null>(null);
  const [editingSealKeyName, setEditingSealKeyName] = useState("");
  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);
  const [editingPackageName, setEditingPackageName] = useState("");

  // Seal key name editing handlers
  const handleStartEditSealKeyName = (keyId: string, currentName: string | undefined | null) => {
    setEditingSealKeyId(keyId);
    setEditingSealKeyName(currentName || "");
  };

  const handleSaveSealKeyNameEdit = (keyId: string) => {
    onUpdateSealKeyName?.(keyId, editingSealKeyName.trim());
    setEditingSealKeyId(null);
    setEditingSealKeyName("");
  };

  const handleCancelSealKeyNameEdit = () => {
    setEditingSealKeyId(null);
    setEditingSealKeyName("");
  };

  // Package name editing handlers
  const handleStartEditPackageName = (packageId: string, currentName: string | undefined | null) => {
    setEditingPackageId(packageId);
    setEditingPackageName(currentName || "");
  };

  const handleSavePackageNameEdit = (keyId: string, packageId: string) => {
    onUpdatePackageName?.(keyId, packageId, editingPackageName.trim());
    setEditingPackageId(null);
    setEditingPackageName("");
  };

  const handleCancelPackageNameEdit = () => {
    setEditingPackageId(null);
    setEditingPackageName("");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Seal Keys & Packages ({sealKeys.length} of {maxSealKeys} used)
        </h3>
      </div>

      {/* Seal Keys List */}
      <div className="space-y-3">
        {sealKeys.map((sealKey) => {
          // Disable most actions during registration or update operations
          const isRegistrationInProgress = sealKey.registrationStatus === 'registering' || sealKey.registrationStatus === 'updating';
          const isActionsDisabled = isReadOnly || isRegistrationInProgress;

          return (
          <div
            key={sealKey.id}
            className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
          >
            {/* Seal Key Header */}
            <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800/30">
              <div className="flex items-center gap-3 flex-1">
                <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
                  {sealKey.key}
                </code>
                {/* Seal Key Name - Inline Editing */}
                {editingSealKeyId === sealKey.id ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={editingSealKeyName}
                      onChange={(e) => setEditingSealKeyName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleSaveSealKeyNameEdit(sealKey.id);
                        } else if (e.key === 'Escape') {
                          handleCancelSealKeyNameEdit();
                        }
                      }}
                      onBlur={() => handleSaveSealKeyNameEdit(sealKey.id)}
                      placeholder="Seal key name"
                      className="h-7 text-sm font-semibold"
                      autoFocus
                      maxLength={64}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSaveSealKeyNameEdit(sealKey.id)}
                      className="h-7 w-7 p-0"
                    >
                      <Check className="h-3 w-3 text-green-600" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancelSealKeyNameEdit}
                      className="h-7 w-7 p-0"
                    >
                      <X className="h-3 w-3 text-red-600" />
                    </Button>
                  </div>
                ) : (
                  <div
                    onClick={() => !isReadOnly && handleStartEditSealKeyName(sealKey.id, sealKey.name)}
                    className={`flex items-center gap-1.5 ${
                      !isReadOnly ? 'cursor-pointer' : ''
                    }`}
                    title={!isReadOnly ? 'Click to edit name' : ''}
                  >
                    <span className={`text-sm font-semibold text-gray-900 dark:text-gray-100 truncate max-w-xs ${
                      !sealKey.name ? 'text-gray-500 dark:text-gray-400 italic' : ''
                    } ${!isReadOnly ? 'hover:text-gray-700 dark:hover:text-gray-300' : ''}`}>
                      {sealKey.name || 'Click to add name'}
                    </span>
                    {!isReadOnly && <Pencil className="h-3 w-3 text-gray-400 dark:text-gray-500 flex-shrink-0" />}
                  </div>
                )}
                {sealKey.isDisabled && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
                    DISABLED
                  </span>
                )}
                {/* Registration Status Badge */}
                <RegistrationStatusBadge
                  status={sealKey.registrationStatus}
                  error={sealKey.registrationError}
                  attempts={sealKey.registrationAttempts}
                  nextRetryAt={sealKey.nextRetryAt}
                />
              </div>

              {/* Seal Key Actions */}
              <div className="flex items-center gap-1.5">
                <InlineButton
                  onClick={() => onExportKey?.(sealKey.id, sealKey.key, sealKey.name ?? undefined)}
                  disabled={isReadOnly}
                >
                  <Download className="h-3 w-3" />
                  Export
                </InlineButton>
                {!sealKey.isDisabled && (
                  <InlineButton
                    onClick={() => onToggleKey?.(sealKey.id, sealKey.isDisabled, sealKey.key, sealKey.name ?? undefined)}
                    disabled={isActionsDisabled}
                  >
                    <Ban className="h-3 w-3" />
                    Disable
                  </InlineButton>
                )}
                {sealKey.isDisabled && (
                  <>
                    <InlineButton
                      onClick={() => onToggleKey?.(sealKey.id, sealKey.isDisabled, sealKey.key, sealKey.name ?? undefined)}
                      disabled={isReadOnly}
                    >
                      Enable
                    </InlineButton>
                    <InlineButton
                      variant="danger"
                      onClick={() => onDeleteKey?.(sealKey.id, sealKey.key, sealKey.name ?? undefined)}
                      disabled={isReadOnly}
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </InlineButton>
                  </>
                )}
              </div>
            </div>

            {/* Seal Key Content (Always Visible) */}
            <div className="p-4 space-y-4 bg-white dark:bg-gray-900">
              {/* Object ID */}
              {sealKey.objectId && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Object ID:</span>
                  <CopyableValue value={sealKey.objectId} />
                </div>
              )}

              {/* Packages */}
              <div className="space-y-2">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Packages ({sealKey.packages.length} of {maxPackagesPerKey} used)
                </div>
                <div className="rounded-lg border border-gray-200 dark:border-gray-700">
                  <table className="w-full">
                    <thead className="bg-gray-50 dark:bg-gray-800/50">
                      <tr>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                          Package Address
                        </th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                          Name
                        </th>
                        <th className="px-3 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                          Status
                        </th>
                        <th className="px-3 py-2 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {[...sealKey.packages]
                        .sort((a, b) => {
                          // Sort by name alphabetically (nulls/empty last), address as tiebreaker
                          const nameA = a.name || '';
                          const nameB = b.name || '';
                          // Push empty names to the end
                          if (!nameA && nameB) return 1;
                          if (nameA && !nameB) return -1;
                          const nameCompare = nameA.localeCompare(nameB);
                          if (nameCompare !== 0) return nameCompare;
                          // Use address as tiebreaker
                          return a.address.localeCompare(b.address);
                        })
                        .map((pkg) => (
                        <tr key={pkg.id} data-testid={`sp-${pkg.id}`}>
                          <td className="px-3 py-3">
                            <CopyableValue
                              value={pkg.address}
                              copyValue={pkg.fullAddress || pkg.address}
                            />
                          </td>
                          <td className="px-3 py-3">
                            {/* Inline name editing */}
                            {editingPackageId === pkg.id ? (
                              <div className="flex items-center gap-1">
                                <Input
                                  value={editingPackageName}
                                  onChange={(e) => setEditingPackageName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      handleSavePackageNameEdit(sealKey.id, pkg.id);
                                    } else if (e.key === 'Escape') {
                                      handleCancelPackageNameEdit();
                                    }
                                  }}
                                  onBlur={() => handleSavePackageNameEdit(sealKey.id, pkg.id)}
                                  placeholder="Package name"
                                  className="h-7 text-sm"
                                  autoFocus
                                  maxLength={64}
                                />
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleSavePackageNameEdit(sealKey.id, pkg.id)}
                                  className="h-7 w-7 p-0"
                                >
                                  <Check className="h-3 w-3 text-green-600" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={handleCancelPackageNameEdit}
                                  className="h-7 w-7 p-0"
                                >
                                  <X className="h-3 w-3 text-red-600" />
                                </Button>
                              </div>
                            ) : (
                              <div
                                onClick={() => !isReadOnly && handleStartEditPackageName(pkg.id, pkg.name)}
                                className={`flex items-center gap-1.5 ${
                                  !isReadOnly ? 'cursor-pointer' : ''
                                }`}
                                title={!isReadOnly ? 'Click to edit name' : ''}
                              >
                                <span className={`text-sm text-gray-900 dark:text-gray-100 ${
                                  !pkg.name ? 'text-gray-500 dark:text-gray-400 italic' : ''
                                } ${!isReadOnly ? 'hover:text-gray-700 dark:hover:text-gray-300' : ''}`}>
                                  {pkg.name || 'Click to add name'}
                                </span>
                                {!isReadOnly && <Pencil className="h-3 w-3 text-gray-400 dark:text-gray-500 flex-shrink-0" />}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <span className={`text-sm ${
                              pkg.isDisabled
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-green-600 dark:text-green-400'
                            }`}>
                              {pkg.isDisabled ? 'Disabled' : 'Enabled'}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              {!pkg.isDisabled && (
                                <InlineButton
                                  onClick={() => onDisablePackage?.(sealKey.id, pkg.id, pkg.address, pkg.name)}
                                  disabled={isActionsDisabled}
                                >
                                  <Ban className="h-3 w-3" />
                                  Disable
                                </InlineButton>
                              )}
                              {pkg.isDisabled && (
                                <>
                                  <InlineButton
                                    onClick={() => onEnablePackage?.(sealKey.id, pkg.id)}
                                    disabled={isActionsDisabled}
                                  >
                                    Enable
                                  </InlineButton>
                                  <InlineButton
                                    variant="danger"
                                    onClick={() => onDeletePackage?.(sealKey.id, pkg.id, pkg.address, pkg.name)}
                                    disabled={isActionsDisabled}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                    Delete
                                  </InlineButton>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Add Package Button */}
                {sealKey.packages.length < maxPackagesPerKey && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onAddPackage?.(sealKey.id)}
                    disabled={isActionsDisabled}
                    className="w-full"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Package to this Seal Key
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
        })}
      </div>

      {/* Add New Seal Key Button */}
      {sealKeys.length < maxSealKeys && (
        <Button
          variant="outline"
          onClick={onAddKey}
          disabled={isReadOnly}
          className="w-full"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add New Seal Key
        </Button>
      )}
    </div>
  );
}
