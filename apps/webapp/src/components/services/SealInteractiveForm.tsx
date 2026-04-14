/**
 * Seal Service Interactive Form
 * For Service State >= 3 (Disabled, Enabled, Suspended)
 * Features:
 * - Tab-based layout (Overview / X-API-Key / Seal Keys / More Settings)
 * - Service enable/disable toggle
 * - Monthly charges breakdown
 * - Field-level actions with immediate effect
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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
import { type ServiceState, type ServiceTier, SERVICE_TYPE, SERVICE_STATE, INVOICE_LINE_ITEM_TYPE, USAGE_PRICING_CENTS_PER_1000 } from "@suiftly/shared/constants";
import { SettingsLink } from "@/components/ui/settings-link";
import { BurstSetting } from "@/components/services/BurstSetting";
import { UsageThisMonth } from "@/components/services/UsageThisMonth";
import type { InvoiceLineItem } from "@suiftly/shared/types";
import {
  fskey_incl,
  fskey_pkg_incl,
} from "@/lib/config";
import { SealKeysSection } from "./SealKeysSection";
import { ApiKeysSection } from "./ApiKeysSection";
import { IpAllowlistSection } from "./IpAllowlistSection";
import { AddPackageModal } from "./AddPackageModal";
import { trpc } from "@/lib/trpc";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { TextRoute } from "@/components/ui/text-route";
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
  /** When true, show the form in read-only preview mode with actions gated */
  isGated?: boolean;
}

export function SealInteractiveForm({
  serviceState,
  tier,
  isEnabled,
  isToggling = false,
  onToggleService,
  isGated = false,
}: SealInteractiveFormProps) {
  // burstEnabled is read directly from moreSettings query (no local state needed)
  const [ipAllowlistEnabled, setIpAllowlistEnabled] = useState(false);

  // IP Allowlist state management
  const [savedIpList, setSavedIpList] = useState<string[]>([]); // Server state
  const [editingIpText, setEditingIpText] = useState("");      // User input
  const [validationErrors, setValidationErrors] = useState<Array<{ ip: string; error: string }>>([]);

  // Package modal state (add only - editing is done inline)
  const [packageModalOpen, setPackageModalOpen] = useState(false);
  const [currentSealKeyId, setCurrentSealKeyId] = useState<string | null>(null);

  // Delete package confirmation state
  const [deletePackageDialog, setDeletePackageDialog] = useState<{
    keyId: string;
    packageId: string;
    packageAddress: string;
    packageName?: string;
  } | null>(null);

  // Disable package confirmation state
  const [disablePackageDialog, setDisablePackageDialog] = useState<{
    keyId: string;
    packageId: string;
    packageAddress: string;
    packageName?: string;
  } | null>(null);

  // Seal key confirmation dialogs
  const [enableSealKeyDialog, setEnableSealKeyDialog] = useState<{
    keyId: string;
    keyPreview: string;
    keyName?: string;
  } | null>(null);

  const [disableSealKeyDialog, setDisableSealKeyDialog] = useState<{
    keyId: string;
    keyPreview: string;
    keyName?: string;
  } | null>(null);

  const [deleteSealKeyDialog, setDeleteSealKeyDialog] = useState<{
    keyId: string;
    keyPreview: string;
    keyName?: string;
  } | null>(null);

  const [exportSealKeyDialog, setExportSealKeyDialog] = useState<{
    keyId: string;
    keyPreview: string;
    keyName?: string;
  } | null>(null);

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

  // Fetch usage statistics from database (disabled in gated mode — no seal service exists yet)
  const { data: usageStats } = trpc.seal.getUsageStats.useQuery(undefined, { enabled: !isGated });

  // Fetch DRAFT invoice to show pending usage charges
  const { data: draftInvoice } = trpc.billing.getNextScheduledPayment.useQuery();

  // Fetch API keys (disabled in gated mode)
  const { data: apiKeys, isLoading: apiKeysLoading } = trpc.seal.listApiKeys.useQuery(undefined, { enabled: !isGated });

  // Fetch seal keys with packages
  // Poll every 3 seconds when any key is registering or updating to show status changes
  const { data: sealKeys, isLoading: sealKeysLoading } = trpc.seal.listKeys.useQuery(undefined, {
    enabled: !isGated,
    refetchInterval: (query) => {
      const keys = query.state.data;
      if (!keys) return false;
      // Poll if any key is in a pending state
      const hasPendingKey = keys.some(
        (key) => key.registrationStatus === 'registering' || key.registrationStatus === 'updating'
      );
      return hasPendingKey ? 3000 : false; // 3 seconds when pending, no polling otherwise
    },
  });

  // API Key mutations
  const createApiKeyMutation = trpc.seal.createApiKey.useMutation({
    onSuccess: () => {
      utils.seal.listApiKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      // Trigger immediate status refetch - config change triggers vault sync
      utils.services.getServicesStatus.invalidate();
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
      // Trigger immediate status refetch - config change triggers vault sync
      utils.services.getServicesStatus.invalidate();
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
      // Trigger immediate status refetch - config change triggers vault sync
      utils.services.getServicesStatus.invalidate();
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
      // Trigger immediate status refetch - config change triggers vault sync
      utils.services.getServicesStatus.invalidate();
      console.log("API key deleted successfully");
    },
    onError: (error) => {
      console.error("Failed to delete API key:", error.message);
    },
  });

  // Seal Key mutations
  const updateSealKeyMutation = trpc.seal.updateKey.useMutation({
    onMutate: async (variables) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await utils.seal.listKeys.cancel();

      // Snapshot the previous value
      const previousData = utils.seal.listKeys.getData();

      // Optimistically update the cache
      utils.seal.listKeys.setData(undefined, (old) => {
        if (!old) return old;

        return old.map(key =>
          key.id === variables.sealKeyId.toString()
            ? { ...key, name: variables.name ?? null }
            : key
        );
      });

      // Return context with the snapshot
      return { previousData };
    },
    onSuccess: () => {
      // Revalidate to ensure sync with server
      utils.seal.listKeys.invalidate();
      // No toast for name updates - it's a quick inline edit
    },
    onError: (error, _variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        utils.seal.listKeys.setData(undefined, context.previousData);
      }
      toast.error(error.message || "Failed to update seal key");
    },
  });

  const toggleSealKeyMutation = trpc.seal.toggleKey.useMutation({
    onSuccess: () => {
      utils.seal.listKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      // Trigger immediate status refetch - config change triggers vault sync
      utils.services.getServicesStatus.invalidate();
      toast.success("Seal key updated");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update seal key");
    },
  });

  // Package mutations
  const addPackageMutation = trpc.seal.addPackage.useMutation({
    onSuccess: () => {
      utils.seal.listKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      // Trigger immediate status refetch - config change triggers vault sync
      utils.services.getServicesStatus.invalidate();
      toast.success("Package added successfully");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to add package");
    },
  });

  const updatePackageMutation = trpc.seal.updatePackage.useMutation({
    onMutate: async (variables) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await utils.seal.listKeys.cancel();

      // Snapshot the previous value
      const previousData = utils.seal.listKeys.getData();

      // Optimistically update the cache
      utils.seal.listKeys.setData(undefined, (old) => {
        if (!old) return old;

        return old.map(key => ({
          ...key,
          packages: key.packages.map(pkg =>
            pkg.id === variables.packageId.toString()
              ? { ...pkg, name: variables.name ?? null }
              : pkg
          ),
        }));
      });

      // Return context with the snapshot
      return { previousData };
    },
    onSuccess: () => {
      // Revalidate to ensure sync with server
      utils.seal.listKeys.invalidate();
      // No toast for name updates - it's a quick inline edit
    },
    onError: (error, _variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        utils.seal.listKeys.setData(undefined, context.previousData);
      }
      toast.error(error.message || "Failed to update package");
    },
  });

  const deletePackageMutation = trpc.seal.deletePackage.useMutation({
    onSuccess: () => {
      utils.seal.listKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      // Trigger immediate status refetch - config change triggers vault sync
      utils.services.getServicesStatus.invalidate();
      toast.success("Package deleted");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete package");
    },
  });

  const togglePackageMutation = trpc.seal.togglePackage.useMutation({
    onSuccess: () => {
      utils.seal.listKeys.invalidate();
      // Trigger immediate status refetch - config change triggers vault sync
      utils.services.getServicesStatus.invalidate();
      toast.success("Package updated");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update package");
    },
  });

  const createSealKeyMutation = trpc.seal.createKey.useMutation({
    onSuccess: () => {
      utils.seal.listKeys.invalidate();
      utils.seal.getUsageStats.invalidate();
      // Trigger immediate status refetch - new seal key needs vault sync
      utils.services.getServicesStatus.invalidate();
      toast.success("Seal key created successfully");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create seal key");
    },
  });

  // Fetch More Settings (disabled in gated mode — no seal service exists yet)
  const { data: moreSettings } = trpc.seal.getMoreSettings.useQuery(undefined, { enabled: !isGated });

  // Burst mutation
  const updateBurstMutation = trpc.seal.updateBurstSetting.useMutation({
    onSuccess: (data) => {
      toast.success(`Burst ${data.burstEnabled ? 'enabled' : 'disabled'}`);
      utils.seal.getMoreSettings.invalidate();
      utils.services.getServicesStatus.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update burst setting');
    },
  });

  // IP Allowlist mutation
  const updateIpAllowlistMutation = trpc.seal.updateIpAllowlist.useMutation({
    onSuccess: (data) => {
      utils.seal.getUsageStats.invalidate();
      utils.seal.getMoreSettings.invalidate();
      // Trigger immediate status refetch to show "Updating..." indicator
      // Config changes set smaConfigChangeVaultSeq, so status will be 'pending'
      utils.services.getServicesStatus.invalidate();

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

  // Sync server settings on initial load.
  // Boolean flags (toggles) always sync from server.
  // IP text only syncs on first load to avoid overwriting user edits
  // when getMoreSettings refetches (e.g. after toggle mutation invalidation).
  // Subsequent updates come through mutation onSuccess handlers.
  const ipTextInitializedRef = useRef(false);

  useEffect(() => {
    if (moreSettings) {
      setIpAllowlistEnabled(moreSettings.ipAllowlistEnabled);

      const ipList = moreSettings.ipAllowlist || [];
      setSavedIpList(ipList);

      if (!ipTextInitializedRef.current) {
        ipTextInitializedRef.current = true;
        setEditingIpText(formatIpAddressListForDisplay(ipList));
      }
    }
    return () => { ipTextInitializedRef.current = false; };
  }, [moreSettings]);

  // Determine if service is cancelled or suspended
  const isCancelled = serviceState === SERVICE_STATE.SUSPENDED_MAINTENANCE || serviceState === SERVICE_STATE.SUSPENDED_NO_PAYMENT;
  // isReadOnly: all mutating actions disabled (cancelled service or gated by missing platform sub)
  const isReadOnly = isCancelled || isGated;

  // Extract Seal usage charge from DRAFT invoice (if any)
  // Filter line items by service === 'seal' and itemType === 'requests'
  const pendingSealUsage = useMemo(() => {
    if (!draftInvoice?.found || !('lineItems' in draftInvoice)) {
      return { quantity: 0, unitPriceUsd: 0, amountUsd: 0 };
    }
    const sealUsageItem = draftInvoice.lineItems.find(
      (item: InvoiceLineItem) =>
        item.service === SERVICE_TYPE.SEAL && item.itemType === INVOICE_LINE_ITEM_TYPE.REQUESTS
    );
    return sealUsageItem
      ? { quantity: sealUsageItem.quantity, unitPriceUsd: sealUsageItem.unitPriceUsd, amountUsd: sealUsageItem.amountUsd }
      : { quantity: 0, unitPriceUsd: 0, amountUsd: 0 };
  }, [draftInvoice]);

  const handleToggleService = (checked: boolean) => {
    onToggleService?.(checked);
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

  // Seal Key handlers
  const handleUpdateSealKeyName = async (keyId: string, newName: string) => {
    // Inline name update - just update the name field
    await updateSealKeyMutation.mutateAsync({
      sealKeyId: parseInt(keyId, 10),
      name: newName,
    });
  };

  const handleToggleSealKey = (keyId: string, currentlyDisabled: boolean, keyPreview: string, keyName?: string) => {
    if (currentlyDisabled) {
      // Show enable confirmation
      setEnableSealKeyDialog({ keyId, keyPreview, keyName });
    } else {
      // Show disable confirmation
      setDisableSealKeyDialog({ keyId, keyPreview, keyName });
    }
  };

  const handleEnableSealKeyConfirm = async () => {
    if (!enableSealKeyDialog) return;

    try {
      await toggleSealKeyMutation.mutateAsync({
        sealKeyId: parseInt(enableSealKeyDialog.keyId, 10),
        enabled: true,
      });
      setEnableSealKeyDialog(null);
    } catch (error) {
      // Error toast is handled by mutation onError
      setEnableSealKeyDialog(null);
    }
  };

  const handleDisableSealKeyConfirm = async () => {
    if (!disableSealKeyDialog) return;

    try {
      await toggleSealKeyMutation.mutateAsync({
        sealKeyId: parseInt(disableSealKeyDialog.keyId, 10),
        enabled: false,
      });
      setDisableSealKeyDialog(null);
    } catch (error) {
      // Error toast is handled by mutation onError
      setDisableSealKeyDialog(null);
    }
  };

  const handleExportSealKey = (keyId: string, keyPreview: string, keyName?: string) => {
    setExportSealKeyDialog({ keyId, keyPreview, keyName });
  };

  const handleDeleteSealKey = (keyId: string, keyPreview: string, keyName?: string) => {
    setDeleteSealKeyDialog({ keyId, keyPreview, keyName });
  };

  const handleAddSealKey = async () => {
    // Name is auto-generated as "seal-key-N" by the backend
    // Users can edit the name later if desired
    await createSealKeyMutation.mutateAsync({});
  };

  // Package handlers
  const handleAddPackage = async (keyId: string) => {
    setCurrentSealKeyId(keyId);
    setPackageModalOpen(true);
  };

  const handleUpdatePackageName = async (keyId: string, packageId: string, newName: string) => {
    // Inline name update - just update the name field
    await updatePackageMutation.mutateAsync({
      packageId: parseInt(packageId, 10),
      name: newName,
    });
  };

  const handlePackageModalSubmit = async (data: { packageAddress: string; name?: string }) => {
    if (currentSealKeyId) {
      await addPackageMutation.mutateAsync({
        sealKeyId: parseInt(currentSealKeyId, 10),
        packageAddress: data.packageAddress,
        name: data.name || undefined,
      });
    }
    setPackageModalOpen(false);
  };

  const handleDeletePackage = async (keyId: string, packageId: string, packageAddress: string, packageName?: string) => {
    setDeletePackageDialog({ keyId, packageId, packageAddress, packageName });
  };

  const handleDeletePackageConfirm = async () => {
    if (!deletePackageDialog) return;

    try {
      await deletePackageMutation.mutateAsync({
        packageId: parseInt(deletePackageDialog.packageId, 10),
      });
      setDeletePackageDialog(null);
    } catch (error) {
      // Error toast is handled by mutation onError
      setDeletePackageDialog(null);
    }
  };

  const handleEnablePackage = async (keyId: string, packageId: string) => {
    try {
      await togglePackageMutation.mutateAsync({
        packageId: parseInt(packageId, 10),
        enabled: true,
      });
    } catch (error) {
      // Error toast is handled by mutation onError
    }
  };

  const handleDisablePackage = async (keyId: string, packageId: string, packageAddress: string, packageName?: string) => {
    setDisablePackageDialog({ keyId, packageId, packageAddress, packageName });
  };

  const handleDisablePackageConfirm = async () => {
    if (!disablePackageDialog) return;

    try {
      await togglePackageMutation.mutateAsync({
        packageId: parseInt(disablePackageDialog.packageId, 10),
        enabled: false,
      });
      setDisablePackageDialog(null);
    } catch (error) {
      // Error toast is handled by mutation onError
      setDisablePackageDialog(null);
    }
  };

  const handleCopyObjectId = (objectId: string) => {
    navigator.clipboard.writeText(objectId);
    toast.success("Object ID copied to clipboard");
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
    fullKey: key.fullKey, // Full key for copying (not rendered to DOM)
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
        <TabsContent value="overview" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Service Overview */}
            <div className="rounded-lg border p-4 dark:border-gray-800">
              <table className="w-full text-sm">
                <tbody>
                  {/* API Keys */}
                  <tr>
                    <td className="py-1.5 text-gray-500 dark:text-gray-400">API Keys</td>
                    <td className="py-1.5 text-gray-900 dark:text-gray-100 text-right">
                      {usageStats?.apiKeys.used ?? 0} of {usageStats?.apiKeys.total ?? 2}
                    </td>
                    <td className="py-1.5 pl-2 w-6">
                      <SettingsLink to="/services/seal/overview" search={{ tab: 'x-api-key' }} />
                    </td>
                  </tr>
                  {/* Seal Keys */}
                  <tr>
                    <td className="py-1.5 text-gray-500 dark:text-gray-400">Seal Keys</td>
                    <td className="py-1.5 text-gray-900 dark:text-gray-100 text-right">
                      {usageStats?.sealKeys.used ?? 0} of {usageStats?.sealKeys.total ?? fskey_incl}
                    </td>
                    <td className="py-1.5 pl-2 w-6">
                      <SettingsLink to="/services/seal/overview" search={{ tab: 'seal-keys' }} />
                    </td>
                  </tr>
                  {/* Packages per Key */}
                  <tr>
                    <td className="py-1.5 text-gray-500 dark:text-gray-400">Packages</td>
                    <td className="py-1.5 text-gray-900 dark:text-gray-100 text-right">
                      {usageStats?.packagesPerKey?.max ?? fskey_pkg_incl} per key
                    </td>
                    <td className="py-1.5 pl-2 w-6" />
                  </tr>
                  {/* Burst */}
                  <tr>
                    <td className="py-1.5 text-gray-500 dark:text-gray-400">Burst</td>
                    <td className="py-1.5 text-gray-900 dark:text-gray-100 text-right">
                      {tier === 'starter'
                        ? <span className="text-gray-400 dark:text-gray-500">Pro only</span>
                        : (moreSettings?.burstEnabled ? 'Enabled' : 'Disabled')}
                    </td>
                    <td className="py-1.5 pl-2 w-6">
                      {tier !== 'starter' && (
                        <SettingsLink to="/services/seal/overview" search={{ tab: 'more-settings' }} />
                      )}
                    </td>
                  </tr>
                  {/* IPv4 Allowlist */}
                  {tier !== 'starter' && (
                    <tr>
                      <td className="py-1.5 text-gray-500 dark:text-gray-400">IPv4 Allowlist</td>
                      <td className="py-1.5 text-gray-900 dark:text-gray-100 text-right">
                        {moreSettings?.ipAllowlistEnabled
                          ? `${usageStats?.allowlist.used ?? 0} / ${usageStats?.allowlist.total ?? 2}`
                          : 'Disabled'}
                      </td>
                      <td className="py-1.5 pl-2 w-6">
                        <SettingsLink to="/services/seal/overview" search={{ tab: 'more-settings' }} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Usage This Month */}
            <UsageThisMonth items={[
              {
                service: SERVICE_TYPE.SEAL,
                itemType: INVOICE_LINE_ITEM_TYPE.REQUESTS,
                quantity: pendingSealUsage.quantity,
                unitPriceUsd: pendingSealUsage.unitPriceUsd || USAGE_PRICING_CENTS_PER_1000[SERVICE_TYPE.SEAL] / 100 / 1000,
                amountUsd: pendingSealUsage.amountUsd,
              },
            ]} />
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
              onRevokeKey={handleRevokeApiKey}
              onReEnableKey={handleReEnableApiKey}
              onDeleteKey={handleDeleteApiKey}
              onAddKey={handleAddApiKey}
            />
          )}
        </TabsContent>

        {/* Seal Keys Tab */}
        <TabsContent value="seal-keys" className="space-y-6">
          {sealKeysLoading ? (
            <div className="text-center py-4 text-gray-500">Loading seal keys...</div>
          ) : (
            <SealKeysSection
              sealKeys={(sealKeys || []).map(key => ({
                id: key.id,
                key: key.keyPreview,
                name: key.name,
                objectId: key.objectIdPreview,
                isDisabled: !key.isUserEnabled,
                // Registration status fields for UI
                registrationStatus: key.registrationStatus as 'registering' | 'registered' | 'updating' | undefined,
                registrationError: key.registrationError,
                registrationAttempts: key.registrationAttempts,
                nextRetryAt: key.nextRetryAt,
                packages: key.packages.map(pkg => ({
                  id: pkg.id,
                  address: pkg.packageAddressPreview,
                  fullAddress: pkg.packageAddress,
                  name: pkg.name || undefined,
                  isDisabled: !pkg.isUserEnabled,
                })),
              }))}
              maxSealKeys={usageStats?.sealKeys.total ?? fskey_incl}
              maxPackagesPerKey={usageStats?.packagesPerKey.max ?? fskey_pkg_incl}
              isReadOnly={isReadOnly}
              onExportKey={handleExportSealKey}
              onToggleKey={handleToggleSealKey}
              onDeleteKey={handleDeleteSealKey}
              onAddKey={handleAddSealKey}
              onAddPackage={handleAddPackage}
              onUpdateSealKeyName={handleUpdateSealKeyName}
              onUpdatePackageName={handleUpdatePackageName}
              onEnablePackage={handleEnablePackage}
              onDisablePackage={handleDisablePackage}
              onDeletePackage={handleDeletePackage}
              onCopyObjectId={handleCopyObjectId}
            />
          )}
        </TabsContent>

        {/* More Settings Tab */}
        <TabsContent value="more-settings" className="mt-4 space-y-6">
          {/* Burst Allowed */}
          <BurstSetting
            checked={moreSettings?.burstEnabled ?? false}
            onCheckedChange={(checked) => updateBurstMutation.mutate({ enabled: checked })}
            disabled={isReadOnly}
            tier={tier}
          />

          {/* IP Allowlist (shared component) */}
          <IpAllowlistSection
            tier={tier}
            isGated={isReadOnly}
            ipAllowlistEnabled={ipAllowlistEnabled}
            ipAllowlist={savedIpList}
            maxIpv4={usageStats?.allowlist.total ?? 2}
            isPending={updateIpAllowlistMutation.isPending}
            onToggle={handleToggleIpAllowlist}
            onSave={async (enabled, entries) => {
              const result = await updateIpAllowlistMutation.mutateAsync({ enabled, entries });
              return { entries: result.entries };
            }}
          />
        </TabsContent>
      </Tabs>

      {/* Add Package Modal */}
      <AddPackageModal
        isOpen={packageModalOpen}
        onClose={() => setPackageModalOpen(false)}
        onSubmit={handlePackageModalSubmit}
        isLoading={addPackageMutation.isPending}
        mode="add"
      />

      {/* Disable Package Confirmation Dialog */}
      <AlertDialog open={!!disablePackageDialog} onOpenChange={(open) => !open && setDisablePackageDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable Package?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disable this package?
              <div className="mt-2 rounded bg-gray-100 dark:bg-gray-900 px-3 py-2">
                {disablePackageDialog?.packageName && (
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                    {disablePackageDialog.packageName}
                  </div>
                )}
                <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                  {disablePackageDialog?.packageAddress}
                </div>
              </div>
              <div className="mt-2 text-gray-900 dark:text-gray-100">
                The package will stop working immediately but can be re-enabled later.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisablePackageConfirm}>
              Disable Package
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Package Confirmation Dialog */}
      <AlertDialog open={!!deletePackageDialog} onOpenChange={(open) => !open && setDeletePackageDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Package?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete this package?
              <div className="mt-2 rounded bg-gray-100 dark:bg-gray-900 px-3 py-2">
                {deletePackageDialog?.packageName && (
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                    {deletePackageDialog.packageName}
                  </div>
                )}
                <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                  {deletePackageDialog?.packageAddress}
                </div>
              </div>
              <div className="mt-2 font-semibold text-red-600 dark:text-red-400">
                This action cannot be undone.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeletePackageConfirm} className="bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700">
              Delete Package
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Enable Seal Key Confirmation Dialog */}
      <AlertDialog open={!!enableSealKeyDialog} onOpenChange={(open) => !open && setEnableSealKeyDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Seal Key?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to enable this seal key?
              <div className="mt-2 rounded bg-gray-100 dark:bg-gray-900 px-3 py-2">
                {enableSealKeyDialog?.keyName && (
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                    {enableSealKeyDialog.keyName}
                  </div>
                )}
                <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                  {enableSealKeyDialog?.keyPreview}
                </div>
              </div>
              <div className="mt-2 text-gray-900 dark:text-gray-100">
                The seal key and its packages will become active immediately.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleEnableSealKeyConfirm}>
              Enable Seal Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disable Seal Key Confirmation Dialog */}
      <AlertDialog open={!!disableSealKeyDialog} onOpenChange={(open) => !open && setDisableSealKeyDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable Seal Key?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disable this seal key?
              <div className="mt-2 rounded bg-gray-100 dark:bg-gray-900 px-3 py-2">
                {disableSealKeyDialog?.keyName && (
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                    {disableSealKeyDialog.keyName}
                  </div>
                )}
                <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                  {disableSealKeyDialog?.keyPreview}
                </div>
              </div>
              <div className="mt-2 text-gray-900 dark:text-gray-100">
                The seal key and all its packages will stop working immediately but can be re-enabled later.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisableSealKeyConfirm}>
              Disable Seal Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Seal Key Dialog */}
      <AlertDialog open={!!deleteSealKeyDialog} onOpenChange={(open) => !open && setDeleteSealKeyDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Seal Key Not Supported</AlertDialogTitle>
            <AlertDialogDescription>
              <div className="mt-2 rounded bg-gray-100 dark:bg-gray-900 px-3 py-2">
                {deleteSealKeyDialog?.keyName && (
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                    {deleteSealKeyDialog.keyName}
                  </div>
                )}
                <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                  {deleteSealKeyDialog?.keyPreview}
                </div>
              </div>
              <div className="mt-3 text-gray-900 dark:text-gray-100">
                Deleting seal keys is not yet supported. You can disable the seal key instead, which will stop all associated packages from working.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setDeleteSealKeyDialog(null)}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Export Seal Key Dialog */}
      <AlertDialog open={!!exportSealKeyDialog} onOpenChange={(open) => !open && setExportSealKeyDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Export Seal Key</AlertDialogTitle>
            <AlertDialogDescription>
              <div className="mt-2 rounded bg-gray-100 dark:bg-gray-900 px-3 py-2">
                {exportSealKeyDialog?.keyName && (
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
                    {exportSealKeyDialog.keyName}
                  </div>
                )}
                <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                  {exportSealKeyDialog?.keyPreview}
                </div>
              </div>
              <div className="mt-3 text-gray-900 dark:text-gray-100">
                Feature coming soon! Contact <span className="font-semibold">support@mhax.io</span> for assistance in the meantime.
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setExportSealKeyDialog(null)}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
