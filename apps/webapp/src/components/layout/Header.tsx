/**
 * Dashboard Header
 * Premium design inspired by Cloudflare
 */

import { WalletButton } from '../wallet/WalletButton';
import { Globe } from 'lucide-react';

export function Header() {
  return (
    <header className="bg-white border-b border-gray-200 h-14 flex items-center justify-between px-6 sticky top-0 z-50">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded flex items-center justify-center">
            <Globe className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900">Suiftly</h1>
        </div>

        {/* Beta Badge */}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium uppercase tracking-wider">
          Beta
        </span>
      </div>

      <WalletButton />
    </header>
  );
}
