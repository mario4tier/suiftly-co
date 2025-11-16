/**
 * API Keys Management Section
 * List of API keys with Copy, Revoke/Enable, Delete actions
 */

import { useState } from "react";
import { Ban, Trash2 } from "lucide-react";
import { InlineButton } from "@/components/ui/inline-button";
import { AddButton } from "@/components/ui/add-button";
import { CopyableValue } from "@/components/ui/copyable-value";
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

interface ApiKey {
  id: string;
  key: string; // Truncated display
  fullKey: string; // Full key for copying (not rendered to DOM)
  isRevoked: boolean;
  createdAt?: string;
}

interface ApiKeysSectionProps {
  apiKeys: ApiKey[];
  maxApiKeys: number;
  isReadOnly?: boolean;
  onRevokeKey?: (keyId: string) => void;
  onReEnableKey?: (keyId: string) => void;
  onDeleteKey?: (keyId: string) => void;
  onAddKey?: () => void;
}

export function ApiKeysSection({
  apiKeys,
  maxApiKeys,
  isReadOnly = false,
  onRevokeKey,
  onReEnableKey,
  onDeleteKey,
  onAddKey,
}: ApiKeysSectionProps) {
  const [disableDialog, setDisableDialog] = useState<{ keyId: string; keyDisplay: string } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{ keyId: string; keyDisplay: string } | null>(null);

  const handleDisableConfirm = () => {
    if (disableDialog) {
      onRevokeKey?.(disableDialog.keyId);
      setDisableDialog(null);
    }
  };

  const handleDeleteConfirm = () => {
    if (deleteDialog) {
      onDeleteKey?.(deleteDialog.keyId);
      setDeleteDialog(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          API Keys ({apiKeys.length} of {maxApiKeys} used)
        </h3>
      </div>

      {/* API Keys Table */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th className="px-3 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                API Key
              </th>
              <th className="px-3 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                Created
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
            {apiKeys.map((apiKey) => (
              <tr key={apiKey.id} data-testid={`apik-${apiKey.id}`}>
                <td className="px-3 py-3">
                  <CopyableValue value={apiKey.key} copyValue={apiKey.fullKey} />
                </td>
                <td className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
                  {apiKey.createdAt}
                </td>
                <td className="px-3 py-3">
                  {apiKey.isRevoked ? (
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
                    {!apiKey.isRevoked && (
                      <InlineButton
                        onClick={() => setDisableDialog({ keyId: apiKey.id, keyDisplay: apiKey.key })}
                        disabled={isReadOnly}
                      >
                        <Ban className="h-3 w-3" />
                        Disable
                      </InlineButton>
                    )}
                    {apiKey.isRevoked && (
                      <>
                        <InlineButton
                          onClick={() => onReEnableKey?.(apiKey.id)}
                          disabled={isReadOnly}
                        >
                          Enable
                        </InlineButton>
                        <InlineButton
                          variant="danger"
                          onClick={() => setDeleteDialog({ keyId: apiKey.id, keyDisplay: apiKey.key })}
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

      {/* Add New API Key Button */}
      {apiKeys.length < maxApiKeys && (
        <AddButton
          onClick={onAddKey}
          disabled={isReadOnly}
        >
          Add New API Key
        </AddButton>
      )}

      {/* Disable Key Confirmation Dialog */}
      <AlertDialog open={!!disableDialog} onOpenChange={(open) => !open && setDisableDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable API Key?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disable this API key?
              <div className="mt-2 rounded bg-gray-100 dark:bg-gray-900 px-3 py-2 font-mono text-sm text-gray-900 dark:text-gray-100">
                {disableDialog?.keyDisplay}
              </div>
              <div className="mt-2 text-gray-900 dark:text-gray-100">
                The key will stop working immediately but can be re-enabled later.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisableConfirm}>
              Disable Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Key Confirmation Dialog */}
      <AlertDialog open={!!deleteDialog} onOpenChange={(open) => !open && setDeleteDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete API Key?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete this API key?
              <div className="mt-2 rounded bg-gray-100 dark:bg-gray-900 px-3 py-2 font-mono text-sm text-gray-900 dark:text-gray-100">
                {deleteDialog?.keyDisplay}
              </div>
              <div className="mt-2 font-semibold text-red-600 dark:text-red-400">
                This action is IRREVERSIBLE.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700">
              Delete Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
