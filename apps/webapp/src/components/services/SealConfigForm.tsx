/**
 * Seal Service Configuration Form
 * Onboarding form for subscribing to Seal service
 * Uses global config variables loaded at app startup
 */

import { useState, useMemo } from "react";
import { Check, Info, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  freg_count,
  fbw_sta,
  fbw_pro,
  fbw_bus,
  fsubs_usd_sta,
  fsubs_usd_pro,
  fsubs_usd_bus,
  fskey_incl,
  fskey_pkg_incl,
  freqs_usd,
  freqs_count,
} from "@/lib/config";
import { TermsOfServiceContent } from "@/components/content/TermsOfServiceContent";

interface SealConfigFormProps {
  onTierChange?: (tierSelected: boolean) => void;
}

type Tier = "starter" | "pro" | "business";

export function SealConfigForm({ onTierChange }: SealConfigFormProps) {
  const [selectedTier, setSelectedTier] = useState<Tier>("pro");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [tosModalOpen, setTosModalOpen] = useState(false);

  const handleTierSelect = (tier: Tier) => {
    setSelectedTier(tier);
    if (onTierChange) {
      onTierChange(true);
    }
  };

  // Tier info using global config variables (zero-cost access)
  const tierInfo = {
    starter: {
      name: "STARTER",
      reqPerRegion: fbw_sta,
      reqGlobal: fbw_sta * freg_count,
      price: fsubs_usd_sta,
      features: "No burst support",
    },
    pro: {
      name: "PRO",
      reqPerRegion: fbw_pro,
      reqGlobal: fbw_pro * freg_count,
      price: fsubs_usd_pro,
      features: "Burst support",
    },
    business: {
      name: "BUSINESS",
      reqPerRegion: fbw_bus,
      reqGlobal: fbw_bus * freg_count,
      price: fsubs_usd_bus,
      features: "Burst support, CIDR Whitelisting",
    },
  };

  // Calculate monthly fee
  const monthlyFee = useMemo(() => {
    return tierInfo[selectedTier].price;
  }, [selectedTier]);

  // Calculate per-request cost (up to 8 digits, no trailing zeros)
  const perRequestCost = useMemo(() => {
    const cost = freqs_usd / freqs_count;
    // Use toPrecision for up to 8 significant digits, then remove trailing zeros
    return parseFloat(cost.toPrecision(8));
  }, []);

  const handleSubscribe = () => {
    // TODO: Implement backend synchronization
    console.log("Subscribe to", selectedTier, "tier");
  };

  const handleDownloadPDF = () => {
    // Download the PDF from public folder
    const link = document.createElement("a");
    link.href = "/terms-of-service.pdf";
    link.download = "suiftly-terms-of-service.pdf";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 py-4">
      {/* Marketing Tagline */}
      <div className="text-center">
        <p className="text-lg text-gray-700 dark:text-gray-300 font-medium">
          Build on guaranteed bandwidth, scale with usage billing
        </p>
      </div>

      {/* Per-Request Pricing Section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Per-Request Pricing
          </h3>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          ${perRequestCost}/req ($
          {freqs_usd % 1 === 0 ? freqs_usd : freqs_usd.toFixed(2)} charged per{" "}
          {freqs_count.toLocaleString()} successful requests)
        </p>
      </div>

      {/* Guaranteed Bandwidth Section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Guaranteed Bandwidth
          </h3>
          <Popover>
            <PopoverTrigger asChild>
              <button className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                <Info className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Select your reserved bandwidth with sub-second guarantee.
                <br />
                <br />
                When response time exceeds 1 second, then the request(s) are not
                charged (dashboard provides relevant metrics).
                <br />
                <br />
                Traffic rate exceeding the guaranteed bandwidth is served
                best-effort when you choose to enable burst support
                (pro/business only).
              </p>
            </PopoverContent>
          </Popover>
        </div>

        {/* Tier Cards */}
        <div className="space-y-3">
          {(["starter", "pro", "business"] as Tier[]).map((tier) => {
            const info = tierInfo[tier];
            const isSelected = selectedTier === tier;

            return (
              <div
                key={tier}
                onClick={() => handleTierSelect(tier)}
                className={`
                  relative cursor-pointer rounded-lg transition-all border-2
                  ${
                    isSelected
                      ? "border-[#f38020] bg-[#f38020]/5"
                      : "border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500"
                  }
                `}
              >
                <div className="p-2">
                  {/* Header Row */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-base font-bold text-gray-900 dark:text-gray-100">
                      {info.name}
                    </span>
                    {isSelected && (
                      <span className="px-3 py-1 text-xs font-semibold rounded-full bg-[#f38020] text-white">
                        SELECTED
                      </span>
                    )}
                  </div>

                  {/* Content Row */}
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                    {info.reqPerRegion} req/s per region ( ~{info.reqGlobal}{" "}
                    req/s globally )
                  </p>

                  {/* Footer Row */}
                  <div className="flex items-center justify-between">
                    <span className="text-base font-semibold text-gray-900 dark:text-gray-100">
                      ${info.price}/month
                    </span>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {info.features}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Included Features */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
        <div className="flex items-start gap-2 mb-3">
          <Check className="h-5 w-5 text-green-600 dark:text-green-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Included with every subscription
            </p>
            <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li className="flex items-center gap-1">
                • Global geo-steering and failover (3 regions: us-east, europe,
                asia)
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                      <Info className="h-3 w-3" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80">
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      Closest key-server automatically selected based on your
                      location.
                      <br />
                      <br /> Regional load-balancing and automatic inter-region
                      failover ensures high availability.
                      <br />
                      <br />
                      We use cloudflare for smart global routing and DDoS
                      protection.
                    </p>
                  </PopoverContent>
                </Popover>
              </li>
              <li>
                • {fskey_incl}x Seal Key, {fskey_pkg_incl}x packages per key
              </li>
              <li>• 2x API-Key</li>
              <li>• 2x IPv4 Whitelisting (optional)</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Optional Add-ons */}
      <div className="text-sm text-gray-600 dark:text-gray-400">
        <span>Optional add-ons are available </span>
        <Popover>
          <PopoverTrigger asChild>
            <button className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <Info className="h-3 w-3 inline" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Additional Seal Keys, packages, API keys, and IP whitelisting can
              be added after subscription.
            </p>
          </PopoverContent>
        </Popover>
      </div>

      {/* Terms of Service */}
      <div className="flex items-center space-x-2">
        <Checkbox
          id="terms"
          checked={termsAccepted}
          onCheckedChange={(checked) => setTermsAccepted(!!checked)}
        />
        <Label
          htmlFor="terms"
          className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
        >
          Agree to{" "}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setTosModalOpen(true);
            }}
            className="text-[#f38020] hover:underline"
          >
            terms of service
          </button>
          {" "}including monthly subscription and per-request charges
        </Label>
      </div>

      {/* Subscribe Button */}
      <Button
        size="lg"
        className="w-full bg-[#f38020] hover:bg-[#d97019] text-white font-semibold"
        disabled={!termsAccepted}
        onClick={handleSubscribe}
      >
        Subscribe to Service for ${monthlyFee.toFixed(2)}/month
      </Button>

      {/* Terms of Service Modal */}
      <Dialog open={tosModalOpen} onOpenChange={setTosModalOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <div className="flex items-start justify-between gap-4 mb-2">
              <div className="flex-1 min-w-0">
                <DialogTitle>Terms of Service</DialogTitle>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDownloadPDF}
                className="flex-shrink-0 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 -mt-1"
              >
                <Download className="h-3 w-3 mr-1" />
                <span className="hidden sm:inline">Download PDF</span>
                <span className="sm:hidden">PDF</span>
              </Button>
            </div>
            <DialogDescription>
              Please review and accept our terms of service
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-y-auto max-h-96 pr-4">
            <TermsOfServiceContent />
          </div>

          <DialogFooter className="flex gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setTosModalOpen(false);
              }}
              className="flex-1 sm:flex-none"
            >
              Cancel
            </Button>
            <Button
              className="bg-[#f38020] hover:bg-[#d97019] text-white flex-1 sm:flex-none"
              onClick={() => {
                setTermsAccepted(true);
                setTosModalOpen(false);
              }}
            >
              I Agree
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
