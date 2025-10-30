/**
 * Sui signature verification
 * Verifies Ed25519 signatures from Sui wallets
 */

import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

/**
 * Verify a Sui wallet signature
 *
 * @param address - Expected wallet address
 * @param message - Original message that was signed
 * @param signature - Signature from wallet
 * @returns true if signature is valid and matches address
 */
export async function verifySuiSignature(
  address: string,
  message: string,
  signature: string
): Promise<boolean> {
  try {
    console.log('[SIGNATURE] Verifying signature for address:', address.slice(0, 10) + '...');

    // Convert message to bytes
    const messageBytes = new TextEncoder().encode(message);

    // Verify signature and get public key
    const publicKey = await verifyPersonalMessageSignature(messageBytes, signature);

    // Derive address from public key
    const derivedAddress = publicKey.toSuiAddress();

    console.log('[SIGNATURE] Derived address:', derivedAddress.slice(0, 10) + '...');
    console.log('[SIGNATURE] Expected address:', address.slice(0, 10) + '...');

    // Check if addresses match
    const isValid = derivedAddress === address;

    if (isValid) {
      console.log('[SIGNATURE] ✓ Signature valid');
    } else {
      console.log('[SIGNATURE] ✗ Signature invalid - address mismatch');
    }

    return isValid;
  } catch (error) {
    console.error('[SIGNATURE] ✗ Signature verification failed:', error);
    return false;
  }
}
