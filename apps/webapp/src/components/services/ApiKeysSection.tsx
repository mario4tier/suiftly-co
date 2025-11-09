/**
 * API Keys Management Section
 * List of API keys with Copy, Revoke/Enable, Delete actions
 */

import { Copy, Ban, Trash2 } from "lucide-react";
import { InlineButton } from "@/components/ui/inline-button";
import { AddButton } from "@/components/ui/add-button";

interface ApiKey {
  id: string;
  key: string; // Truncated display
  isRevoked: boolean;
  createdAt?: string;
}

interface ApiKeysSectionProps {
  apiKeys: ApiKey[];
  maxApiKeys: number;
  isReadOnly?: boolean;
  onCopyKey?: (keyId: string) => void;
  onRevokeKey?: (keyId: string) => void;
  onReEnableKey?: (keyId: string) => void;
  onDeleteKey?: (keyId: string) => void;
  onAddKey?: () => void;
}

export function ApiKeysSection({
  apiKeys,
  maxApiKeys,
  isReadOnly = false,
  onCopyKey,
  onRevokeKey,
  onReEnableKey,
  onDeleteKey,
  onAddKey,
}: ApiKeysSectionProps) {
  const handleCopyKey = (keyId: string, fullKey: string) => {
    // In real implementation, fetch full key from secure endpoint
    navigator.clipboard.writeText(fullKey);
    onCopyKey?.(keyId);
    console.log("Copied API key:", keyId);
  };

  const handleRevokeKey = (keyId: string, keyDisplay: string) => {
    const confirmed = window.confirm(
      `Revoke this API key?\n\n${keyDisplay}\n\nThe key will stop working immediately but can be re-enabled later.`
    );
    if (confirmed) {
      onRevokeKey?.(keyId);
    }
  };

  const handleDeleteKey = (keyId: string, keyDisplay: string) => {
    const confirmed = window.confirm(
      `Delete this API key?\n\n${keyDisplay}\n\nThis action is IRREVERSIBLE.`
    );
    if (confirmed) {
      onDeleteKey?.(keyId);
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
              <tr key={apiKey.id}>
                <td className="px-3 py-3">
                  <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
                    {apiKey.key}
                  </code>
                </td>
                <td className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
                  {apiKey.createdAt}
                </td>
                <td className="px-3 py-3">
                  {apiKey.isRevoked ? (
                    <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                      Revoked
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
                      <>
                        <InlineButton
                          onClick={() => handleCopyKey(apiKey.id, apiKey.key)}
                          disabled={isReadOnly}
                        >
                          <Copy className="h-3 w-3" />
                          Copy
                        </InlineButton>
                        <InlineButton
                          onClick={() => handleRevokeKey(apiKey.id, apiKey.key)}
                          disabled={isReadOnly}
                        >
                          <Ban className="h-3 w-3" />
                          Revoke
                        </InlineButton>
                      </>
                    )}
                    {apiKey.isRevoked && (
                      <>
                        <InlineButton
                          onClick={() => onReEnableKey?.(apiKey.id)}
                          disabled={isReadOnly}
                        >
                          Re-enable
                        </InlineButton>
                        <InlineButton
                          variant="danger"
                          onClick={() => handleDeleteKey(apiKey.id, apiKey.key)}
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
    </div>
  );
}
