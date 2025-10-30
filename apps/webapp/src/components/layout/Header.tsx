/**
 * Dashboard Header
 * Cloudflare-inspired design using Tailwind CSS
 */

import { WalletButton } from '../wallet/WalletButton';

export function Header() {
  return (
    <header className="bg-white border-b border-dust h-14 flex items-center justify-between px-6 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-3">
        <span className="text-xl font-semibold text-charcoal">
          Suiftly
        </span>
        <span className="text-cf-xs px-2 py-0.5 rounded bg-moonshine text-storm font-semibold">
          BETA
        </span>
      </div>

      {/* Wallet */}
      <WalletButton />
    </header>
  );
}
