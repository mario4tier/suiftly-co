/**
 * Dashboard Header
 * Premium design inspired by Cloudflare
 */

import { WalletWidget } from '../wallet/WalletWidget';
import { ThemeToggle } from '../theme/ThemeToggle';
import { Globe } from 'lucide-react';

export function Header() {
  return (
    <header className="bg-white dark:bg-gray-900 border-b border-[#e5e7eb] dark:border-[#374151] h-12 flex items-center justify-between px-6">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded flex items-center justify-center">
            <Globe className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-50">Suiftly</h1>
        </div>

        {/* Beta Badge */}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 font-medium uppercase tracking-wider">
          Beta
        </span>
      </div>

      <div className="flex items-center gap-3">
        <ThemeToggle />
        <WalletWidget />
      </div>
    </header>
  );
}
