/**
 * CopyableValue Component
 * Displays a value with a small copy icon and optional explorer link
 *
 * Usage:
 * - Simple value: <CopyableValue value="sk_abc123..." />
 * - With explorer: <CopyableValue value="0x123..." type="sui_address_mainnet" />
 */

import { Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

type ValueType =
  | "default"
  | "sui_address_mainnet"
  | "sui_address_testnet"
  | "sui_object_mainnet"
  | "sui_object_testnet"
  | "sui_txn_mainnet"
  | "sui_txn_testnet";

interface CopyableValueProps {
  value: string; // Display value (can be truncated)
  type?: ValueType;
  label?: string; // Optional label before the value
  className?: string;
  /**
   * Optional full value to copy (if different from display value)
   * Use this for truncated displays where you want to copy the full value
   * The full value is kept in memory but never rendered to DOM
   */
  copyValue?: string;
}

const EXPLORER_URLS: Record<Exclude<ValueType, "default">, (value: string) => string> = {
  sui_address_mainnet: (v) => `https://suiscan.xyz/mainnet/account/${v}`,
  sui_address_testnet: (v) => `https://suiscan.xyz/testnet/account/${v}`,
  sui_object_mainnet: (v) => `https://suiscan.xyz/mainnet/object/${v}`,
  sui_object_testnet: (v) => `https://suiscan.xyz/testnet/object/${v}`,
  sui_txn_mainnet: (v) => `https://suiscan.xyz/mainnet/tx/${v}`,
  sui_txn_testnet: (v) => `https://suiscan.xyz/testnet/tx/${v}`,
};

export function CopyableValue({
  value,
  type = "default",
  label,
  className = "",
  copyValue
}: CopyableValueProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    // Use copyValue if provided, otherwise use display value
    const valueToCopy = copyValue ?? value;

    await navigator.clipboard.writeText(valueToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExplorerClick = () => {
    if (type !== "default") {
      const url = EXPLORER_URLS[type](value);
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const hasExplorer = type !== "default";

  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      {label && (
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {label}
        </span>
      )}
      <code className="text-sm font-mono text-gray-900 dark:text-gray-100">
        {value}
      </code>
      <div className="relative inline-flex">
        <button
          onClick={handleCopy}
          className="inline-flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 rounded p-0.5 transition-colors cursor-pointer"
        >
          <Copy
            className={`h-3.5 w-3.5 ${
              copied
                ? "text-green-600 dark:text-green-400"
                : "text-gray-500 dark:text-gray-400"
            }`}
          />
        </button>
        {copied && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-900 dark:bg-gray-700 text-white text-xs rounded whitespace-nowrap pointer-events-none">
            Copied!
          </div>
        )}
      </div>
      {hasExplorer && (
        <button
          onClick={handleExplorerClick}
          className="inline-flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 rounded p-0.5 transition-colors cursor-pointer"
          title="View in explorer"
        >
          <ExternalLink className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
        </button>
      )}
    </div>
  );
}
