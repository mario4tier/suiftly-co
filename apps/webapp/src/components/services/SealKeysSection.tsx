/**
 * Seal Keys & Packages Management Section
 * Cards showing seal keys with nested packages (always visible)
 */

import { useState } from "react";
import { Download, Ban, Trash2, Plus, Check, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyableValue } from "@/components/ui/copyable-value";
import { InlineButton } from "@/components/ui/inline-button";

interface SealKey {
  id: string;
  key: string; // Truncated display
  name?: string | null; // User-defined name
  objectId?: string; // Sui object ID (truncated)
  isDisabled: boolean;
  packages: Package[];
}

interface Package {
  id: string;
  address: string; // Truncated for display
  fullAddress?: string; // Full address for copying
  name?: string;
  isDisabled: boolean; // Package enable/disable status
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
        {sealKeys.map((sealKey) => (
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
                    disabled={isReadOnly}
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
                      {sealKey.packages.map((pkg) => (
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
                            {/* Status Badge */}
                            {pkg.isDisabled ? (
                              <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                                Disabled
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                Active
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              {!pkg.isDisabled && (
                                <InlineButton
                                  onClick={() => onDisablePackage?.(sealKey.id, pkg.id, pkg.address, pkg.name)}
                                  disabled={isReadOnly}
                                >
                                  <Ban className="h-3 w-3" />
                                  Disable
                                </InlineButton>
                              )}
                              {pkg.isDisabled && (
                                <>
                                  <InlineButton
                                    onClick={() => onEnablePackage?.(sealKey.id, pkg.id)}
                                    disabled={isReadOnly}
                                  >
                                    Enable
                                  </InlineButton>
                                  <InlineButton
                                    variant="danger"
                                    onClick={() => onDeletePackage?.(sealKey.id, pkg.id, pkg.address, pkg.name)}
                                    disabled={isReadOnly}
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
                    disabled={isReadOnly}
                    className="w-full"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Package to this Seal Key
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
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
