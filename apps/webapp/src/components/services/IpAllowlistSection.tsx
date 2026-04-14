/**
 * IP Allowlist Section - Shared between Seal and gRPC services
 *
 * Handles:
 * - Toggle enable/disable
 * - Textarea for editing IPs
 * - Real-time validation
 * - Save/Cancel with correct button visibility (disappear after successful save)
 * - Tier gating (Pro only)
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { Info, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  parseIpAddressList,
  formatIpAddressListForDisplay,
  areIpListsEqual,
} from "@suiftly/shared/schemas";
import type { ServiceTier } from "@suiftly/shared/constants";
import { toast } from "sonner";

export interface IpAllowlistSectionProps {
  /** Current tier (starter = disabled/gated) */
  tier: ServiceTier;
  /** Whether the section is read-only (gated preview) */
  isGated?: boolean;
  /** Server state: is allowlist enabled? */
  ipAllowlistEnabled: boolean;
  /** Server state: current saved IP list */
  ipAllowlist: string[];
  /** Max IPs allowed (from usage stats) */
  maxIpv4: number;
  /** Whether a mutation is in progress */
  isPending: boolean;
  /** Called when toggle changes (enabled flag only, no IP entries) */
  onToggle: (enabled: boolean) => void;
  /** Called when Save is pressed (enabled + entries) */
  onSave: (enabled: boolean, entries: string) => Promise<{ entries: string[] } | void>;
}

export function IpAllowlistSection({
  tier,
  isGated = false,
  ipAllowlistEnabled,
  ipAllowlist,
  maxIpv4,
  isPending,
  onToggle,
  onSave,
}: IpAllowlistSectionProps) {
  // Local editing state
  const [savedIpList, setSavedIpList] = useState<string[]>([]);
  const [editingIpText, setEditingIpText] = useState("");
  const [validationErrors, setValidationErrors] = useState<Array<{ ip: string; error: string }>>([]);
  const ipTextInitializedRef = useRef(false);

  // Sync from server on initial load and after successful mutations
  // Only set editing text on first load to avoid overwriting user edits during refetch
  useEffect(() => {
    setSavedIpList(ipAllowlist);
    if (!ipTextInitializedRef.current) {
      setEditingIpText(formatIpAddressListForDisplay(ipAllowlist));
      ipTextInitializedRef.current = true;
    }
    return () => { ipTextInitializedRef.current = false; };
  }, [ipAllowlist]);

  const handleIpTextChange = (value: string) => {
    setEditingIpText(value);
    const { errors } = parseIpAddressList(value);
    setValidationErrors(errors);
  };

  const handleSave = async () => {
    const { ips, errors } = parseIpAddressList(editingIpText);

    if (errors.length > 0) {
      toast.error("Please fix validation errors before saving");
      return;
    }

    if (ips.length > maxIpv4) {
      toast.error(`Maximum ${maxIpv4} IPv4 addresses allowed. You have ${ips.length}.`);
      return;
    }

    try {
      const result = await onSave(ipAllowlistEnabled, editingIpText);

      // Update saved state from server response so buttons disappear
      if (result?.entries) {
        setSavedIpList(result.entries);
        setEditingIpText(formatIpAddressListForDisplay(result.entries));
      } else {
        // Fallback: use what we parsed
        setSavedIpList(ips);
        setEditingIpText(formatIpAddressListForDisplay(ips));
      }
      setValidationErrors([]);
      toast.success('IP Allowlist saved successfully');
    } catch {
      // Error handled by caller's mutation onError
    }
  };

  const handleCancel = () => {
    setEditingIpText(formatIpAddressListForDisplay(savedIpList));
    setValidationErrors([]);
  };

  // Detect unsaved changes (includes validation errors)
  const hasUnsavedChanges = useMemo(() => {
    if (validationErrors.length > 0) return true;
    const { ips } = parseIpAddressList(editingIpText);
    return !areIpListsEqual(savedIpList, ips);
  }, [editingIpText, savedIpList, validationErrors]);

  return (
    <div className="rounded-lg border p-4 dark:border-gray-800">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="ip-allowlist-toggle" className="text-sm font-medium">
            IP Allowlist
          </Label>
          <Popover>
            <PopoverTrigger>
              <Info className="h-4 w-4 text-gray-400" />
            </PopoverTrigger>
            <PopoverContent className="text-sm max-w-xs">
              Restrict access to specific IPv4 addresses. Only listed IPs can use your API keys.
            </PopoverContent>
          </Popover>
        </div>
        <Switch
          id="ip-allowlist-toggle"
          checked={ipAllowlistEnabled}
          onCheckedChange={onToggle}
          disabled={isGated || tier === 'starter'}
        />
      </div>

      {tier === 'starter' ? (
        <p className="text-xs text-gray-500">Available on Pro tier only</p>
      ) : (
        <>
          <Textarea
            id="ip-allowlist"
            value={editingIpText}
            onChange={(e) => handleIpTextChange(e.target.value)}
            rows={2}
            disabled={isGated}
            className="text-sm"
          />

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div className="mt-2 rounded-md bg-red-50 dark:bg-red-900/20 p-3 border border-red-200 dark:border-red-900">
              <div className="flex gap-2">
                <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-500 flex-shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-red-800 dark:text-red-200">
                    Validation Errors:
                  </p>
                  <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                    {validationErrors.map((err, i) => (
                      <li key={i} className="font-mono">
                        <span className="font-bold">{err.ip}</span>: {err.error}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Save/Cancel - only shown when there are unsaved changes */}
          {hasUnsavedChanges && (
            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleSave}
                disabled={validationErrors.length > 0 || isPending}
                size="sm"
              >
                {isPending ? "Saving..." : "Save Changes"}
              </Button>
              <Button
                onClick={handleCancel}
                disabled={isPending}
                variant="outline"
                size="sm"
              >
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
