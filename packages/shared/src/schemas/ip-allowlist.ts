/**
 * IP Allowlist Validation Schema
 * Shared between frontend and backend for consistent validation
 */

import { z } from 'zod';

/**
 * Validates a single IPv4 address
 * Supports: a.b.c.d or a.b.c.d/32
 * Rejects: IPv6, CIDR ranges other than /32
 */
export const ipv4AddressSchema = z.string().refine(
  (value) => {
    // Remove /32 suffix if present
    const ipPart = value.endsWith('/32') ? value.slice(0, -3) : value;

    // Check for IPv4 format
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = ipPart.match(ipv4Regex);

    if (!match) {
      return false;
    }

    // Validate each octet is 0-255
    for (let i = 1; i <= 4; i++) {
      const octet = parseInt(match[i], 10);
      if (octet < 0 || octet > 255) {
        return false;
      }
    }

    return true;
  },
  {
    message: 'Invalid IPv4 address. Use format: a.b.c.d or a.b.c.d/32 (e.g., 192.168.1.1)',
  }
);

/**
 * Rejects IPv6 addresses with helpful error message
 */
export const notIpv6Schema = z.string().refine(
  (value) => {
    // Check for IPv6 patterns (contains colons)
    return !value.includes(':');
  },
  {
    message: 'IPv6 addresses are not supported yet. Please use IPv4 addresses only.',
  }
);

/**
 * Rejects CIDR ranges other than /32
 */
export const noCidrSchema = z.string().refine(
  (value) => {
    // Allow /32 but reject other CIDR notations
    if (value.includes('/')) {
      return value.endsWith('/32');
    }
    return true;
  },
  {
    message: 'CIDR ranges (other than /32) are not supported yet. Use individual IP addresses (e.g., 192.168.1.1).',
  }
);

/**
 * Combined IPv4 validation with helpful error messages
 * Validates format and provides specific feedback for common mistakes
 */
export const singleIpSchema = z
  .string()
  .trim()
  .min(7, 'IP address is too short. Use format: a.b.c.d')
  .max(18, 'IP address is too long. Use format: a.b.c.d or a.b.c.d/32')
  .pipe(notIpv6Schema)
  .pipe(noCidrSchema)
  .pipe(ipv4AddressSchema);

/**
 * Parses and normalizes IP addresses from user input
 * - Removes /32 suffixes (stored without suffix)
 * - Trims whitespace
 * - Removes duplicates
 */
export function normalizeIpAddress(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.endsWith('/32') ? trimmed.slice(0, -3) : trimmed;
}

/**
 * Parses multiple IP addresses from text input
 * Supports: newline, comma, or space separated
 * Returns: Array of normalized unique IPs and validation errors
 */
export function parseIpAddressList(input: string): {
  ips: string[];
  errors: Array<{ ip: string; error: string }>;
  hasChanges: boolean;
} {
  if (!input || input.trim().length === 0) {
    return { ips: [], errors: [], hasChanges: false };
  }

  // Split by newline, comma, or space
  const entries = input
    .split(/[\n,\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  const ips: string[] = [];
  const errors: Array<{ ip: string; error: string }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const result = singleIpSchema.safeParse(entry);

    if (result.success) {
      const normalized = normalizeIpAddress(entry);

      // Check for duplicates
      if (seen.has(normalized)) {
        errors.push({
          ip: entry,
          error: `Duplicate IP address: ${normalized}`,
        });
      } else {
        seen.add(normalized);
        ips.push(normalized);
      }
    } else {
      errors.push({
        ip: entry,
        error: result.error.errors[0]?.message || 'Invalid IP address',
      });
    }
  }

  return { ips, errors, hasChanges: ips.length > 0 || errors.length > 0 };
}

/**
 * Formats IP addresses for display
 * Up to 10 IPs per line, comma+space separated
 */
export function formatIpAddressListForDisplay(ips: string[]): string {
  if (ips.length === 0) {
    return '';
  }

  const lines: string[] = [];

  for (let i = 0; i < ips.length; i += 10) {
    const chunk = ips.slice(i, i + 10);
    lines.push(chunk.join(', '));
  }

  return lines.join('\n');
}

/**
 * Compares two IP lists for semantic equality
 * Returns true if the lists contain the same IPs (order doesn't matter)
 */
export function areIpListsEqual(list1: string[], list2: string[]): boolean {
  if (list1.length !== list2.length) {
    return false;
  }

  const set1 = new Set(list1.map(normalizeIpAddress));
  const set2 = new Set(list2.map(normalizeIpAddress));

  if (set1.size !== set2.size) {
    return false;
  }

  for (const ip of set1) {
    if (!set2.has(ip)) {
      return false;
    }
  }

  return true;
}

/**
 * Schema for IP allowlist update API
 * - enabled: Controls whether IP allowlist is enforced
 * - entries: Optional. When provided, updates the IP list; when omitted, only toggles enabled state
 */
export const ipAllowlistUpdateSchema = z.object({
  enabled: z.boolean(),
  entries: z.string().optional(),
});

/**
 * Type for IP allowlist update
 */
export type IpAllowlistUpdate = z.infer<typeof ipAllowlistUpdateSchema>;
