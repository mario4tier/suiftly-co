/**
 * API Keys Management Section
 * List of API keys with Copy, Revoke/Enable, Delete actions
 */

import { Copy, Ban, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  onToggleKey?: (keyId: string, revoke: boolean) => void;
  onDeleteKey?: (keyId: string) => void;
  onAddKey?: () => void;
}

export function ApiKeysSection({
  apiKeys,
  maxApiKeys,
  isReadOnly = false,
  onCopyKey,
  onToggleKey,
  onDeleteKey,
  onAddKey,
}: ApiKeysSectionProps) {
  const handleCopyKey = (keyId: string, fullKey: string) => {
    // In real implementation, fetch full key from secure endpoint
    navigator.clipboard.writeText(fullKey);
    onCopyKey?.(keyId);
    console.log("Copied API key:", keyId);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          API Keys ({apiKeys.length} of {maxApiKeys} used)
        </h3>
      </div>

      {/* API Keys List */}
      <div className="space-y-3">
        {apiKeys.map((apiKey) => (
          <div
            key={apiKey.id}
            className="flex items-center justify-between p-4 rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <div className="flex items-center gap-3">
              <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
                {apiKey.key}
              </code>
              {apiKey.isRevoked && (
                <span className="px-2 py-0.5 text-xs font-semibold rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
                  REVOKED
                </span>
              )}
              {apiKey.createdAt && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Created {apiKey.createdAt}
                </span>
              )}
            </div>

            {/* API Key Actions */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCopyKey(apiKey.id, apiKey.key)}
                disabled={isReadOnly || apiKey.isRevoked}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onToggleKey?.(apiKey.id, !apiKey.isRevoked)}
                disabled={isReadOnly}
              >
                <Ban className="h-3 w-3 mr-1" />
                {apiKey.isRevoked ? "Enable" : "Revoke"}
              </Button>
              {apiKey.isRevoked && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onDeleteKey?.(apiKey.id)}
                  disabled={isReadOnly}
                  className="text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Delete
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add New API Key Button */}
      {apiKeys.length < maxApiKeys && (
        <Button
          variant="outline"
          onClick={onAddKey}
          disabled={isReadOnly}
          className="w-full"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add New API Key
        </Button>
      )}
    </div>
  );
}
