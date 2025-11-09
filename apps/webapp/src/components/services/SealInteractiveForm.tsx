/**
 * Seal Service Interactive Form
 * For Service State >= 3 (Disabled, Enabled, Suspended)
 * Features:
 * - Tab-based layout (Configuration / Keys)
 * - Service enable/disable toggle
 * - Monthly charges breakdown
 * - Field-level actions with immediate effect
 */

import { useState, useMemo } from "react";
import { Info, Plus } from "lucide-react";
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
import { useSearch } from "@tanstack/react-router";

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
  const [ipAllowlist, setIpAllowlist] = useState("");
  const utils = trpc.useUtils();

  // Read tab from URL query parameter for deep linking
  const searchParams = useSearch({ strict: false }) as { tab?: string };
  const validTabs = ["configuration", "x-api-key", "seal-keys"];
  const defaultTab = validTabs.includes(searchParams.tab || "") ? searchParams.tab! : "configuration";

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
    console.log("Burst toggled:", checked);
    // TODO: API call to update burst setting
  };

  const handleIpAllowlistChange = (value: string) => {
    setIpAllowlist(value);
    // TODO: Debounced API call to update IP allowlist
  };

  // API Key handlers
  const handleAddApiKey = async () => {
    await createApiKeyMutation.mutateAsync({});
  };

  const handleCopyApiKey = (keyId: string) => {
    navigator.clipboard.writeText(keyId);
    console.log("Copied API key to clipboard:", keyId);
  };

  const handleRevokeApiKey = async (keyId: string) => {
    await revokeApiKeyMutation.mutateAsync({ apiKeyId: keyId });
  };

  const handleReEnableApiKey = async (keyId: string) => {
    await reEnableApiKeyMutation.mutateAsync({ apiKeyId: keyId });
  };

  const handleDeleteApiKey = async (keyId: string) => {
    await deleteApiKeyMutation.mutateAsync({ apiKeyId: keyId });
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
    id: key.apiKeyId,
    key: key.keyPreview,
    isRevoked: !key.isActive,
    createdAt: formatRelativeTime(new Date(key.createdAt)),
  })) || [];

  return (
    <div className="max-w-5xl mx-auto space-y-4 py-4">
      {/* Tabs: Configuration, X-API-Key, Seal Keys */}
      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="x-api-key">X-API-Key</TabsTrigger>
          <TabsTrigger value="seal-keys">Seal Keys</TabsTrigger>
        </TabsList>

        {/* Configuration Tab */}
        <TabsContent value="configuration" className="space-y-6">
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
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 dark:text-gray-300">
                      Description
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 dark:text-gray-300">
                      Usage/Count
                    </th>
                    <th className="px-4 py-3 text-center text-sm font-semibold text-gray-700 dark:text-gray-300">
                      Action
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700 dark:text-gray-300">
                      Monthly Price
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {/* Guaranteed Bandwidth */}
                  <tr>
                    <td className="px-4 py-3">
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          Guaranteed Bandwidth
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {currentTier.reqPerRegion} req/s per region
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                      {currentTier.reqPerRegion * freg_count} req/s globally
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="text-xs text-gray-500 dark:text-gray-400">Included</span>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      ${monthlyCharges.guaranteedBandwidth.toFixed(2)}
                    </td>
                  </tr>

                  {/* Seal Keys */}
                  <tr>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        Seal Keys
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                      {usageStats?.sealKeys.used ?? 0} of {usageStats?.sealKeys.total ?? fskey_incl}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button variant="outline" size="sm" disabled={isReadOnly}>
                        <Plus className="h-3 w-3 mr-1" />
                        Add More
                      </Button>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      ${monthlyCharges.sealKeys.toFixed(2)}
                    </td>
                  </tr>

                  {/* IPv4 Allowlist */}
                  {tier !== "starter" && (
                    <tr>
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          IPv4 Allowlist
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                        {usageStats?.allowlist.used ?? 0} of {usageStats?.allowlist.total ?? 2}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Button variant="outline" size="sm" disabled={isReadOnly}>
                          <Plus className="h-3 w-3 mr-1" />
                          Add More
                        </Button>
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                        ${monthlyCharges.ipv4Allowlist.toFixed(2)}
                      </td>
                    </tr>
                  )}

                  {/* Packages per Key */}
                  <tr>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        Packages per Key
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                      {usageStats?.packages.reduce((sum, pkg) => sum + pkg.used, 0) ?? 0}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button variant="outline" size="sm" disabled={isReadOnly}>
                        <Plus className="h-3 w-3 mr-1" />
                        Add More
                      </Button>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      ${monthlyCharges.packagesPerKey.toFixed(2)}
                    </td>
                  </tr>

                  {/* API Keys */}
                  <tr>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        API Keys
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                      {usageStats?.apiKeys.used ?? 0} of {usageStats?.apiKeys.total ?? 2}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button variant="outline" size="sm" disabled={isReadOnly}>
                        <Plus className="h-3 w-3 mr-1" />
                        Add More
                      </Button>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      ${monthlyCharges.apiKeys.toFixed(2)}
                    </td>
                  </tr>

                  {/* Total Row */}
                  <tr className="bg-gray-50 dark:bg-gray-800/50">
                    <td colSpan={3} className="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                      Total Monthly Fee
                    </td>
                    <td className="px-4 py-3 text-right text-lg font-bold text-gray-900 dark:text-gray-100">
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

          {/* Burst Allowed */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
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
              {tier === "starter" ? (
                <span className="text-sm text-gray-500 dark:text-gray-400">Pro/Enterprise feature</span>
              ) : (
                <>
                  <Switch
                    id="burst-toggle"
                    checked={burstEnabled}
                    onCheckedChange={handleToggleBurst}
                    disabled={isReadOnly}
                  />
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                    {burstEnabled ? "ON" : "OFF"}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* IP Allowlist */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="ip-allowlist" className="text-sm font-medium text-gray-900 dark:text-gray-100">
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
                    Restrict API access to specific IP addresses or CIDR ranges. Leave empty to allow all IPs.
                    <br /><br />
                    Format: One per line, space, or comma-separated.
                    {tier === "enterprise" && (
                      <>
                        <br /><br />
                        <strong>Pro:</strong> Up to 2 IPv4 addresses
                        <br />
                        <strong>Enterprise:</strong> Up to 2 IPv4 addresses + 2 CIDR ranges
                      </>
                    )}
                  </p>
                </PopoverContent>
              </Popover>
            </div>
            {tier === "starter" ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Pro/Enterprise feature</p>
            ) : (
              <Textarea
                id="ip-allowlist"
                placeholder="192.168.1.100, 10.0.0.0/24"
                value={ipAllowlist}
                onChange={(e) => handleIpAllowlistChange(e.target.value)}
                disabled={isReadOnly}
                className="min-h-[100px]"
              />
            )}
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
      </Tabs>
    </div>
  );
}
