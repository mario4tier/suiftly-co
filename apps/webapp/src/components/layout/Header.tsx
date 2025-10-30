/**
 * Dashboard Header
 * Matches Cloudflare cf-ui design system
 */

import { WalletButton } from '../wallet/WalletButton';

export function Header() {
  return (
    <header
      className="bg-white border-b h-14 flex items-center justify-between px-6 shrink-0"
      style={{ borderColor: '#ebebeb' }} // Cloudflare Dust
    >
      {/* Logo */}
      <div className="flex items-center gap-3">
        <span className="text-xl font-semibold" style={{ color: '#333333' }}>
          Suiftly
        </span>
        <span
          className="text-xs px-2 py-0.5 rounded font-semibold"
          style={{ backgroundColor: '#F7F7F7', color: '#808285' }}
        >
          BETA
        </span>
      </div>

      {/* Wallet */}
      <WalletButton />
    </header>
  );
}
