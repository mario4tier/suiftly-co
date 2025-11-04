/**
 * Seal Keys & Packages Management Section
 * Expandable cards showing seal keys with nested packages
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, Download, Ban, Trash2, Plus, Edit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface SealKey {
  id: string;
  key: string; // Truncated display
  objectId?: string; // Sui object ID (truncated)
  isDisabled: boolean;
  packages: Package[];
}

interface Package {
  id: string;
  address: string; // Truncated
  name?: string;
}

interface SealKeysSectionProps {
  sealKeys: SealKey[];
  maxSealKeys: number;
  maxPackagesPerKey: number;
  isReadOnly?: boolean;
  onExportKey?: (keyId: string) => void;
  onToggleKey?: (keyId: string, disable: boolean) => void;
  onDeleteKey?: (keyId: string) => void;
  onAddKey?: () => void;
  onAddPackage?: (keyId: string) => void;
  onEditPackage?: (keyId: string, packageId: string) => void;
  onDeletePackage?: (keyId: string, packageId: string) => void;
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
  onEditPackage,
  onDeletePackage,
  onCopyObjectId,
}: SealKeysSectionProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set(sealKeys.map((k) => k.id)));

  const toggleKeyExpansion = (keyId: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) {
        next.delete(keyId);
      } else {
        next.add(keyId);
      }
      return next;
    });
  };

  const handleCopyObjectId = (objectId: string) => {
    navigator.clipboard.writeText(objectId);
    onCopyObjectId?.(objectId);
    console.log("Copied object ID:", objectId);
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
          <Collapsible
            key={sealKey.id}
            open={expandedKeys.has(sealKey.id)}
            onOpenChange={() => toggleKeyExpansion(sealKey.id)}
          >
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              {/* Seal Key Header */}
              <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800/30">
                <div className="flex items-center gap-3 flex-1">
                  <CollapsibleTrigger asChild>
                    <button className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                      {expandedKeys.has(sealKey.id) ? (
                        <ChevronUp className="h-5 w-5" />
                      ) : (
                        <ChevronDown className="h-5 w-5" />
                      )}
                    </button>
                  </CollapsibleTrigger>
                  <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
                    {sealKey.key}
                  </code>
                  {sealKey.isDisabled && (
                    <span className="px-2 py-0.5 text-xs font-semibold rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
                      DISABLED
                    </span>
                  )}
                </div>

                {/* Seal Key Actions */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onExportKey?.(sealKey.id)}
                    disabled={isReadOnly}
                  >
                    <Download className="h-3 w-3 mr-1" />
                    Export
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onToggleKey?.(sealKey.id, !sealKey.isDisabled)}
                    disabled={isReadOnly}
                  >
                    <Ban className="h-3 w-3 mr-1" />
                    {sealKey.isDisabled ? "Enable" : "Disable"}
                  </Button>
                  {sealKey.isDisabled && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onDeleteKey?.(sealKey.id)}
                      disabled={isReadOnly}
                      className="text-red-600 hover:text-red-700 dark:text-red-400"
                    >
                      <Trash2 className="h-3 w-3 mr-1" />
                      Delete
                    </Button>
                  )}
                </div>
              </div>

              {/* Seal Key Content (Collapsible) */}
              <CollapsibleContent>
                <div className="p-4 space-y-4 bg-white dark:bg-gray-900">
                  {/* Object ID */}
                  {sealKey.objectId && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600 dark:text-gray-400">Object ID:</span>
                      <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
                        {sealKey.objectId}
                      </code>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCopyObjectId(sealKey.objectId!)}
                        className="h-6 w-6 p-0"
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  )}

                  {/* Packages */}
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Packages ({sealKey.packages.length} of {maxPackagesPerKey} used)
                    </div>
                    <div className="space-y-2">
                      {sealKey.packages.map((pkg) => (
                        <div
                          key={pkg.id}
                          className="flex items-center justify-between p-2 rounded border border-gray-200 dark:border-gray-700"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-900 dark:text-gray-100">•</span>
                            <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
                              {pkg.address}
                            </code>
                            {pkg.name && (
                              <span className="text-sm text-gray-500 dark:text-gray-400">
                                ({pkg.name})
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onEditPackage?.(sealKey.id, pkg.id)}
                              disabled={isReadOnly}
                            >
                              <Edit className="h-3 w-3 mr-1" />
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onDeletePackage?.(sealKey.id, pkg.id)}
                              disabled={isReadOnly}
                              className="text-red-600 hover:text-red-700 dark:text-red-400"
                            >
                              <Trash2 className="h-3 w-3 mr-1" />
                              Delete
                            </Button>
                          </div>
                        </div>
                      ))}
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
              </CollapsibleContent>
            </div>
          </Collapsible>
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
