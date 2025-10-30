/**
 * Dashboard Header
 * Clean, modern design with Tailwind CSS
 */

import { WalletButton } from '../wallet/WalletButton';

export function Header() {
  return (
    <header className="bg-white border-b border-border h-16 flex items-center justify-between px-6 sticky top-0 z-50">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-foreground">Suiftly</h1>
        <span className="text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground font-medium">
          BETA
        </span>
      </div>

      <WalletButton />
    </header>
  );
}
