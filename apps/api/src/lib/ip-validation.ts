/**
 * IP Address and CIDR validation utilities
 */

/**
 * Validates an IPv4 address
 * Example: "192.168.1.1"
 */
export function isValidIPv4(ip: string): boolean {
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = ip.match(ipv4Regex);

  if (!match) {
    return false;
  }

  // Check each octet is 0-255
  for (let i = 1; i <= 4; i++) {
    const octet = parseInt(match[i], 10);
    if (octet < 0 || octet > 255) {
      return false;
    }
  }

  return true;
}

/**
 * Validates a CIDR range
 * Example: "10.0.0.0/24"
 */
export function isValidCIDR(cidr: string): boolean {
  const cidrRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
  const match = cidr.match(cidrRegex);

  if (!match) {
    return false;
  }

  // Validate IP part
  for (let i = 1; i <= 4; i++) {
    const octet = parseInt(match[i], 10);
    if (octet < 0 || octet > 255) {
      return false;
    }
  }

  // Validate prefix length (0-32)
  const prefix = parseInt(match[5], 10);
  if (prefix < 0 || prefix > 32) {
    return false;
  }

  return true;
}

/**
 * Validates an IP address or CIDR range
 */
export function isValidIPOrCIDR(input: string): boolean {
  return isValidIPv4(input) || isValidCIDR(input);
}

/**
 * Parse and validate multiple IP addresses/CIDR ranges
 * Supports: newline, comma, and space separated values
 */
export function parseIPAllowlist(input: string): { valid: string[], invalid: string[] } {
  // Split by newline, comma, or space, and filter empty strings
  const entries = input
    .split(/[\n,\s]+/)
    .map(e => e.trim())
    .filter(e => e.length > 0);

  const valid: string[] = [];
  const invalid: string[] = [];

  for (const entry of entries) {
    if (isValidIPOrCIDR(entry)) {
      valid.push(entry);
    } else {
      invalid.push(entry);
    }
  }

  return { valid, invalid };
}

/**
 * Count IPv4 addresses and CIDR ranges separately
 */
export function countIPTypes(entries: string[]): { ipv4Count: number, cidrCount: number } {
  let ipv4Count = 0;
  let cidrCount = 0;

  for (const entry of entries) {
    if (isValidIPv4(entry)) {
      ipv4Count++;
    } else if (isValidCIDR(entry)) {
      cidrCount++;
    }
  }

  return { ipv4Count, cidrCount };
}
