/**
 * Seal Service Interactive Form
 * For Service State >= 3 (Disabled, Enabled, Suspended)
 * Features:
 * - Tab-based layout (Overview / X-API-Key / Seal Keys / More Settings)
 * - Service enable/disable toggle
 * - Monthly charges breakdown
 * - Field-level actions with immediate effect
 */

import { useState, useEffect, useMemo } from "react";
import { Info, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { type ServiceState, type ServiceTier } from "@suiftly/shared/constants";
import {
  freg_count,
  fbw_sta,
  fbw_pro,
  fbw_ent,
  fsubs_usd_sta,
  fsubs_usd_pro,
  fsubs_usd_ent,
  fskey_incl,
  fskey_pkg_incl,
} from "@/lib/config";
import { SealKeysSection } from "./SealKeysSection";
import { ApiKeysSection } from "./ApiKeysSection";
import { trpc } from "@/lib/trpc";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { LinkButton } from "@/components/ui/link-button";
import { toast } from "sonner";
import {
  parseIpAddressList,
  formatIpAddressListForDisplay,
  areIpListsEqual,
} from "@suiftly/shared/schemas";

interface SealInteractiveFormProps {
  serviceState: ServiceState;
  tier: ServiceTier;
  isEnabled: boolean;
  isToggling?: boolean;
  onToggleService?: (enabled: boolean) => void;
  onChangePlan?: () => void;
}

export function SealInteractiveForm({
  serviceState,
  tier,
  isEnabled,
  isToggling = false,
  onToggleService,
  onChangePlan,
}: SealInteractiveFormProps) {
  const [burstEnabled, setBurstEnabled] = useState(tier !== "starter");
  const [ipAllowlistEnabled, setIpAllowlistEnabled] = useState(false);

  // IP Allowlist state management
  const [savedIpList, setSavedIpList] = useState<string[]>([]); // Server state
  const [editingIpText, setEditingIpText] = useState("");      // User input
  const [validationErrors, setValidationErrors] = useState<Array<{ ip: string; error: string }>>([]);

  const utils = trpc.useUtils();
  const navigate = useNavigate();

  // Read tab from URL query parameter for deep linking
  const searchParams = useSearch({ strict: false }) as { tab?: string };
  const validTabs = ["overview", "x-api-key", "seal-keys", "more-settings"];
  const currentTab = validTabs.includes(searchParams.tab || "") ? searchParams.tab! : "overview";

  // Handle tab change by updating URL
  const handleTabChange = (tab: string) => {
    navigate({
      to: "/services/seal/overview",
      search: { tab },
    });
  };

  // Fetch usage statistics from database
  const { data: usageStats } = trpc.seal.getUsageStats.useQuery();

  // Fetch API keys
  const { data: apiKeys, isLoading: apiKeysLoading } = trpc.seal.listApiKeys.useQuery();

  // API Key mutations
  const createApiKeyMutation = trpc.seal.createApiKey.useMutation({
    onSuccess: () => {
      utils.seal.listApiKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      console.log("API key created successfully");
    },
    onError: (error) => {
      console.error("Failed to create API key:", error.message);
    },
  });

  const revokeApiKeyMutation = trpc.seal.revokeApiKey.useMutation({
    onSuccess: () => {
      utils.seal.listApiKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      console.log("API key revoked successfully");
    },
    onError: (error) => {
      console.error("Failed to revoke API key:", error.message);
    },
  });

  const reEnableApiKeyMutation = trpc.seal.reEnableApiKey.useMutation({
    onSuccess: () => {
      utils.seal.listApiKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      console.log("API key re-enabled successfully");
    },
    onError: (error) => {
      console.error("Failed to re-enable API key:", error.message);
    },
  });

  const deleteApiKeyMutation = trpc.seal.deleteApiKey.useMutation({
    onSuccess: () => {
      utils.seal.listApiKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      console.log("API key deleted successfully");
    },
    onError: (error) => {
      console.error("Failed to delete API key:", error.message);
    },
  });

  // Fetch More Settings
  const { data: moreSettings } = trpc.seal.getMoreSettings.useQuery();

  // Burst mutation
  const updateBurstMutation = trpc.seal.updateBurstSetting.useMutation({
    onSuccess: (data) => {
      toast.success(`Burst ${data.burstEnabled ? 'enabled' : 'disabled'}`);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update burst setting');
      // Revert UI state on error
      setBurstEnabled(!burstEnabled);
    },
  });

  // IP Allowlist mutation
  const updateIpAllowlistMutation = trpc.seal.updateIpAllowlist.useMutation({
    onSuccess: (data) => {
      utils.seal.getUsageStats.invalidate();
      utils.seal.getMoreSettings.invalidate();

      // Update saved state with server response
      setSavedIpList(data.entries);
      setEditingIpText(formatIpAddressListForDisplay(data.entries));
      setValidationErrors([]);

      // Toast messages are handled by individual action handlers
      // (handleToggleIpAllowlist or handleSaveIpAllowlist)
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update IP allowlist');
    },
  });

  // Load settings from backend on mount
  useEffect(() => {
    if (moreSettings) {
      setBurstEnabled(moreSettings.burstEnabled);
      setIpAllowlistEnabled(moreSettings.ipAllowlistEnabled);

      // Load and format IP list
      const ipList = moreSettings.ipAllowlist || [];
      setSavedIpList(ipList);
      setEditingIpText(formatIpAddressListForDisplay(ipList));
    }
  }, [moreSettings]);

  // Determine if service is cancelled or suspended
  const isCancelled = serviceState === "suspended_maintenance" || serviceState === "suspended_no_payment";
  const isReadOnly = isCancelled;

  // Tier info
  const tierInfo = {
    starter: {
      name: "STARTER",
      reqPerRegion: fbw_sta,
      price: fsubs_usd_sta,
    },
    pro: {
      name: "PRO",
      reqPerRegion: fbw_pro,
      price: fsubs_usd_pro,
    },
    enterprise: {
      name: "ENTERPRISE",
      reqPerRegion: fbw_ent,
      price: fsubs_usd_ent,
    },
  };

  const currentTier = tierInfo[tier];

  // Monthly charges calculation (mock data for now)
  const monthlyCharges = {
    guaranteedBandwidth: currentTier.price,
    sealKeys: 0, // 1 of 1 used (included)
    ipv4Allowlist: 0, // 1 of 1 used (included for Pro/Enterprise)
    packagesPerKey: 0, // Using 3 of 3 included
    apiKeys: 0, // 1 of 2 used (included)
  };

  const totalMonthlyFee =
    monthlyCharges.guaranteedBandwidth +
    monthlyCharges.sealKeys +
    monthlyCharges.ipv4Allowlist +
    monthlyCharges.packagesPerKey +
    monthlyCharges.apiKeys;

  const handleToggleService = (checked: boolean) => {
    onToggleService?.(checked);
  };

  const handleToggleBurst = (checked: boolean) => {
    setBurstEnabled(checked);
    updateBurstMutation.mutate({ enabled: checked });
  };

  // IP Allowlist handlers
  const handleToggleIpAllowlist = async (checked: boolean) => {
    setIpAllowlistEnabled(checked);

    try {
      // Toggle ON/OFF without modifying the IP list
      // This operation is independent of editing/saving IPs
      await updateIpAllowlistMutation.mutateAsync({
        enabled: checked,
        // Don't send entries - only toggle the enabled flag
      });

      // Show appropriate message for toggle action
      toast.success(checked ? 'IP Allowlist enabled' : 'IP Allowlist disabled');
    } catch (error) {
      // Error already handled by mutation's onError
      // Revert UI state
      setIpAllowlistEnabled(!checked);
    }
  };

  const handleIpTextChange = (value: string) => {
    setEditingIpText(value);

    // Run client-side validation in real-time
    const { ips, errors } = parseIpAddressList(value);
    setValidationErrors(errors);
  };

  const handleSaveIpAllowlist = async () => {
    const { ips, errors } = parseIpAddressList(editingIpText);

    if (errors.length > 0) {
      toast.error("Please fix validation errors before saving");
      return;
    }

    // Check tier limit from actual usage stats
    // This ensures customers with purchased additional capacity aren't blocked
    const maxIpv4 = usageStats?.allowlist.total ?? 2;
    if (ips.length > maxIpv4) {
      toast.error(`Maximum ${maxIpv4} IPv4 addresses allowed for your configuration`);
      return;
    }

    try {
      await updateIpAllowlistMutation.mutateAsync({
        enabled: ipAllowlistEnabled,
        entries: editingIpText,
      });

      // Show success message for saving changes
      toast.success('IP Allowlist saved successfully');
    } catch (error) {
      // Error already handled by mutation's onError
    }
  };

  const handleCancelIpChanges = () => {
    // Revert to saved state
    setEditingIpText(formatIpAddressListForDisplay(savedIpList));
    setValidationErrors([]);
  };

  // Detect if there are unsaved changes
  // Include validation errors so invalid edits also surface Save/Cancel buttons
  const hasUnsavedIpChanges = useMemo(() => {
    // If there are validation errors, user has made changes that need to be addressed
    if (validationErrors.length > 0) {
      return true;
    }

    // Otherwise, compare the valid parsed IPs to the saved list
    const { ips } = parseIpAddressList(editingIpText);
    return !areIpListsEqual(savedIpList, ips);
  }, [editingIpText, savedIpList, validationErrors]);

  // API Key handlers
  const handleAddApiKey = async () => {
    await createApiKeyMutation.mutateAsync({});
  };

  const handleCopyApiKey = (keyId: string) => {
    // Note: ApiKeysSection already handles clipboard.writeText()
    // This callback is only for side effects (logging, analytics, etc.)
    console.log("Copied API key to clipboard:", keyId);
  };

  const handleRevokeApiKey = async (keyId: string) => {
    await revokeApiKeyMutation.mutateAsync({ apiKeyFp: parseInt(keyId, 10) });
  };

  const handleReEnableApiKey = async (keyId: string) => {
    await reEnableApiKeyMutation.mutateAsync({ apiKeyFp: parseInt(keyId, 10) });
  };

  const handleDeleteApiKey = async (keyId: string) => {
    await deleteApiKeyMutation.mutateAsync({ apiKeyFp: parseInt(keyId, 10) });
  };

  // Helper function to format relative time
  const formatRelativeTime = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffMinutes > 0) return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
    return 'just now';
  };

  // Format API keys for display
  const formattedApiKeys = apiKeys?.map(key => ({
    id: key.apiKeyFp.toString(), // Use fingerprint (PRIMARY KEY) for identification
    key: key.keyPreview,
    isRevoked: !key.isUserEnabled,
    createdAt: formatRelativeTime(new Date(key.createdAt)),
  })) || [];

  return (
    <div className="max-w-5xl mx-auto space-y-4 py-4">
      {/* Tabs: Overview, X-API-Key, Seal Keys, More Settings */}
      <Tabs value={currentTab} onValueChange={handleTabChange} className="w-full">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="x-api-key">X-API-Key</TabsTrigger>
          <TabsTrigger value="seal-keys">Seal Keys</TabsTrigger>
          <TabsTrigger value="more-settings">More Settings</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          {/* Monthly Charges Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Monthly Charges - {currentTier.name}
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={onChangePlan}
                disabled={isReadOnly}
              >
                Change Plan
              </Button>
            </div>

            {/* Monthly Charges Table */}
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-gray-800/50">
                  <tr>
                    <th className="px-4 py-1.5 text-left text-sm font-semibold text-gray-700 dark:text-gray-300">
                      Description
                    </th>
                    <th className="px-4 py-1.5 text-left text-sm font-semibold text-gray-700 dark:text-gray-300">
                      Usage/Count
                    </th>
                    <th className="py-1.5 text-left text-sm font-semibold text-gray-700 dark:text-gray-300">
                      {/* Action header removed */}
                    </th>
                    <th className="px-4 py-1.5 text-right text-sm font-semibold text-gray-700 dark:text-gray-300">
                      Monthly Price
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {/* Guaranteed Bandwidth */}
                  <tr>
                    <td className="px-4 py-1.5">
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          Guaranteed Bandwidth
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {currentTier.reqPerRegion} req/s per region
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-400">
                      ~{currentTier.reqPerRegion * freg_count} req/s globally
                    </td>
                    <td className="py-1.5">
                      {/* No action for Guaranteed Bandwidth */}
                    </td>
                    <td className="px-4 py-1.5 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      ${monthlyCharges.guaranteedBandwidth.toFixed(2)}
                    </td>
                  </tr>

                  {/* API Keys */}
                  <tr>
                    <td className="px-4 py-1.5">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        API Keys
                      </div>
                    </td>
                    <td className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-400">
                      {usageStats?.apiKeys.used ?? 0} of {usageStats?.apiKeys.total ?? 2}
                    </td>
                    <td className="py-1.5">
                      <LinkButton
                        to="/services/seal/overview"
                        search={{ tab: "x-api-key" }}
                      >
                        Manage
                      </LinkButton>
                    </td>
                    <td className="px-4 py-1.5 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      ${monthlyCharges.apiKeys.toFixed(2)}
                    </td>
                  </tr>

                  {/* Seal Keys */}
                  <tr>
                    <td className="px-4 py-1.5">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        Seal Keys
                      </div>
                    </td>
                    <td className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-400">
                      {usageStats?.sealKeys.used ?? 0} of {usageStats?.sealKeys.total ?? fskey_incl}
                    </td>
                    <td className="py-1.5">
                      <LinkButton
                        to="/services/seal/overview"
                        search={{ tab: "seal-keys" }}
                      >
                        Manage
                      </LinkButton>
                    </td>
                    <td className="px-4 py-1.5 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      ${monthlyCharges.sealKeys.toFixed(2)}
                    </td>
                  </tr>

                  {/* Packages per Key */}
                  <tr>
                    <td className="px-4 py-1.5">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        Packages
                      </div>
                    </td>
                    <td className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-400">
                      {usageStats?.packagesPerKey?.max ?? fskey_pkg_incl} per key
                    </td>
                    <td className="py-1.5">
                      {/* No action for Packages per Key */}
                    </td>
                    <td className="px-4 py-1.5 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      ${monthlyCharges.packagesPerKey.toFixed(2)}
                    </td>
                  </tr>

                  {/* IPv4 Allowlist */}
                  {tier !== "starter" && (
                    <tr>
                      <td className="px-4 py-1.5">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          IPv4 Allowlist
                        </div>
                      </td>
                      <td className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-400">
                        {usageStats?.allowlist.used ?? 0} of {usageStats?.allowlist.total ?? 2}
                      </td>
                      <td className="py-1.5">
                        <LinkButton
                          to="/services/seal/overview"
                          search={{ tab: "more-settings" }}
                        >
                          Manage
                        </LinkButton>
                      </td>
                      <td className="px-4 py-1.5 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                        ${monthlyCharges.ipv4Allowlist.toFixed(2)}
                      </td>
                    </tr>
                  )}

                  {/* Total Row */}
                  <tr className="bg-gray-50 dark:bg-gray-800/50">
                    <td colSpan={3} className="px-4 py-1.5 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                      Total Monthly Fee
                    </td>
                    <td className="px-4 py-1.5 text-right text-lg font-bold text-gray-900 dark:text-gray-100">
                      ${totalMonthlyFee.toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Pending Per-Request Charges */}
          <div className="flex items-center justify-between p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/30">
            <div>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Pending Per-Request Charges:
              </span>
              <span className="ml-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                $0.00
              </span>
            </div>
            <Button variant="link" size="sm" className="text-[#f38020] hover:text-[#d97019]">
              See Details
            </Button>
          </div>
        </TabsContent>

        {/* X-API-Key Tab */}
        <TabsContent value="x-api-key" className="space-y-6">
          {apiKeysLoading ? (
            <div className="text-center py-4 text-gray-500">Loading API keys...</div>
          ) : (
            <ApiKeysSection
              apiKeys={formattedApiKeys}
              maxApiKeys={usageStats?.apiKeys.total ?? 2}
              isReadOnly={isReadOnly}
              onCopyKey={handleCopyApiKey}
              onRevokeKey={handleRevokeApiKey}
              onReEnableKey={handleReEnableApiKey}
              onDeleteKey={handleDeleteApiKey}
              onAddKey={handleAddApiKey}
            />
          )}
        </TabsContent>

        {/* Seal Keys Tab */}
        <TabsContent value="seal-keys" className="space-y-6">
          <SealKeysSection
            sealKeys={[
              {
                id: "1",
                key: "seal_xyz789...",
                objectId: "0xabcde...",
                isDisabled: false,
                packages: [
                  { id: "1", address: "0x1234...abcd", name: "package-1" },
                  { id: "2", address: "0x5678...efgh", name: "package-2" },
                  { id: "3", address: "0x9abc...ijkl", name: "package-3" },
                ],
              },
            ]}
            maxSealKeys={fskey_incl}
            maxPackagesPerKey={fskey_pkg_incl}
            isReadOnly={isReadOnly}
            onExportKey={(keyId) => console.log("Export key:", keyId)}
            onToggleKey={(keyId, disable) => console.log("Toggle key:", keyId, disable)}
            onDeleteKey={(keyId) => console.log("Delete key:", keyId)}
            onAddKey={() => console.log("Add key")}
            onAddPackage={(keyId) => console.log("Add package to key:", keyId)}
            onEditPackage={(keyId, pkgId) => console.log("Edit package:", keyId, pkgId)}
            onDeletePackage={(keyId, pkgId) => console.log("Delete package:", keyId, pkgId)}
            onCopyObjectId={(objId) => console.log("Copied object ID:", objId)}
          />
        </TabsContent>

        {/* More Settings Tab */}
        <TabsContent value="more-settings" className="space-y-6">
          {/* Burst Allowed */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label htmlFor="burst-toggle" className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Burst Allowed
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                      <Info className="h-4 w-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80">
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      Allow temporary traffic bursts beyond guaranteed bandwidth. Billed per-request for burst traffic.
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
              {tier === "starter" ? (
                <span className="text-sm text-gray-500 dark:text-gray-400">Pro/Enterprise feature</span>
              ) : (
                <div className="flex items-center gap-3">
                  <Switch
                    id="burst-toggle"
                    checked={burstEnabled}
                    onCheckedChange={handleToggleBurst}
                    disabled={isReadOnly}
                  />
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[32px]">
                    {burstEnabled ? "ON" : "OFF"}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* IP Allowlist */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label htmlFor="ip-allowlist-toggle" className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  IP Allowlist
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                      <Info className="h-4 w-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80">
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      Restrict API access to specific IPv4 addresses. When OFF, all IPs are allowed.
                      <br /><br />
                      <strong>Format:</strong> Separate with newlines, commas, or spaces.
                      <br />
                      <strong>Example:</strong> 192.168.1.1, 10.0.0.1
                      <br /><br />
                      <strong>Limit:</strong> Up to 2 IPv4 addresses for Pro tier
                      <br /><br />
                      <strong>Note:</strong> IPv6 and CIDR ranges (except /32) are not supported yet.
                    </p>
                  </PopoverContent>
                </Popover>
                {tier !== "starter" && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {usageStats?.allowlist.used ?? 0} of {usageStats?.allowlist.total ?? 2} used
                  </span>
                )}
              </div>
              {tier === "starter" ? (
                <span className="text-sm text-gray-500 dark:text-gray-400">Pro/Enterprise feature</span>
              ) : (
                <div className="flex items-center gap-3">
                  <Switch
                    id="ip-allowlist-toggle"
                    checked={ipAllowlistEnabled}
                    onCheckedChange={handleToggleIpAllowlist}
                    disabled={isReadOnly}
                  />
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[32px]">
                    {ipAllowlistEnabled ? "ON" : "OFF"}
                  </span>
                </div>
              )}
            </div>

            {/* IP Allowlist Editor (Pro/Enterprise only) */}
            {tier !== "starter" && (
              <>
                <Textarea
                  id="ip-allowlist"
                  value={editingIpText}
                  onChange={(e) => handleIpTextChange(e.target.value)}
                  disabled={isReadOnly}
                  rows={2}
                  className="resize-none font-mono text-sm"
                />

                {/* Validation Errors */}
                {validationErrors.length > 0 && (
                  <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 border border-red-200 dark:border-red-900">
                    <div className="flex gap-2">
                      <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-500 flex-shrink-0" />
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-red-800 dark:text-red-200">
                          Validation Errors:
                        </p>
                        <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                          {validationErrors.map((error, idx) => (
                            <li key={idx} className="font-mono">
                              • <span className="font-bold">{error.ip}</span>: {error.error}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {/* Save/Cancel Buttons */}
                {hasUnsavedIpChanges && (
                  <div className="flex gap-2 pt-2">
                    <Button
                      onClick={handleSaveIpAllowlist}
                      disabled={validationErrors.length > 0 || updateIpAllowlistMutation.isPending}
                      size="sm"
                    >
                      {updateIpAllowlistMutation.isPending ? "Saving..." : "Save Changes"}
                    </Button>
                    <Button
                      onClick={handleCancelIpChanges}
                      disabled={updateIpAllowlistMutation.isPending}
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
