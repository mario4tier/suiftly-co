/**
 * Add/Edit Package Modal
 * Modal form for adding or editing seal packages with validation
 */

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { mockAuth } from "@/lib/config";

interface AddPackageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: { packageAddress: string; name?: string }) => void;
  isLoading?: boolean;
  mode: 'add' | 'edit';
  initialData?: {
    packageAddress?: string;
    name?: string;
  };
}

export function AddPackageModal({
  isOpen,
  onClose,
  onSubmit,
  isLoading = false,
  mode,
  initialData,
}: AddPackageModalProps) {
  const [packageAddress, setPackageAddress] = useState(initialData?.packageAddress || '');
  const [name, setName] = useState(initialData?.name || '');
  const [errors, setErrors] = useState<{ packageAddress?: string; name?: string }>({});

  // Reset form when modal opens/closes or initialData changes
  useEffect(() => {
    if (isOpen) {
      setPackageAddress(initialData?.packageAddress || '');
      setName(initialData?.name || '');
      setErrors({});
    }
  }, [isOpen, initialData]);

  const validatePackageAddress = (value: string): string | undefined => {
    if (!value.trim()) {
      return 'Package address is required';
    }

    // Must be 0x followed by exactly 64 hex characters (32 bytes)
    const hexPattern = /^0x[0-9a-fA-F]{64}$/;
    if (!hexPattern.test(value)) {
      return 'Must be a valid 32-byte hex address (0x + 64 hex characters)';
    }

    return undefined;
  };

  const validateName = (value: string): string | undefined => {
    if (value && value.length > 64) {
      return 'Name must be 64 characters or less';
    }
    return undefined;
  };

  const handlePackageAddressChange = (value: string) => {
    setPackageAddress(value);
    const error = validatePackageAddress(value);
    setErrors(prev => ({ ...prev, packageAddress: error }));
  };

  const handleNameChange = (value: string) => {
    setName(value);
    const error = validateName(value);
    setErrors(prev => ({ ...prev, name: error }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate all fields
    const addressError = validatePackageAddress(packageAddress);
    const nameError = validateName(name);

    if (addressError || nameError) {
      setErrors({
        packageAddress: addressError,
        name: nameError,
      });
      return;
    }

    // Submit the form
    onSubmit({
      packageAddress: packageAddress.trim(),
      name: name.trim() || undefined,
    });
  };

  const handleCancel = () => {
    setPackageAddress('');
    setName('');
    setErrors({});
    onClose();
  };

  // Test helper: Generate random valid package address
  const fillTestAddress = () => {
    // Generate 32 random bytes (64 hex characters)
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const hexString = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const testAddress = `0x${hexString}`;
    handlePackageAddressChange(testAddress);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleCancel}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {mode === 'add' ? 'Add Package' : 'Edit Package'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* Package Address Field */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="packageAddress">
                  Package Address <span className="text-red-500">*</span>
                </Label>
                {mockAuth && mode === 'add' && (
                  <button
                    type="button"
                    onClick={fillTestAddress}
                    className="inline-flex items-center justify-center w-5 h-5 text-xs font-mono border border-gray-300 dark:border-gray-600 rounded bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                    title="Fill with random test address"
                  >
                    T
                  </button>
                )}
              </div>
              <Input
                id="packageAddress"
                value={packageAddress}
                onChange={(e) => handlePackageAddressChange(e.target.value)}
                placeholder="0x0000000000000000000000000000000000000000000000000000000000000000"
                disabled={isLoading || (mode === 'edit' && !!initialData?.packageAddress)}
                className={errors.packageAddress ? 'border-red-500' : ''}
                autoComplete="off"
                spellCheck={false}
              />
              {errors.packageAddress && (
                <div className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle className="h-3 w-3" />
                  <span>{errors.packageAddress}</span>
                </div>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                32-byte hex address (0x followed by 64 hex characters)
                {mode === 'edit' && initialData?.packageAddress && (
                  <span className="block mt-1 text-amber-600 dark:text-amber-400">
                    Address cannot be changed after creation
                  </span>
                )}
              </p>
            </div>

            {/* Name Field */}
            <div className="space-y-2">
              <Label htmlFor="name">
                Name (Optional)
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="My Package"
                disabled={isLoading}
                className={errors.name ? 'border-red-500' : ''}
                maxLength={64}
              />
              {errors.name && (
                <div className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle className="h-3 w-3" />
                  <span>{errors.name}</span>
                </div>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Optional friendly name for this package (max 64 characters)
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isLoading || !!errors.packageAddress || !!errors.name}
            >
              {isLoading ? 'Saving...' : mode === 'add' ? 'Add Package' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
