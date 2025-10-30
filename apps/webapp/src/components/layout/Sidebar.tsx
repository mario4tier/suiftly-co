/**
 * Dashboard Sidebar
 * Premium design with professional icons
 */

import { Link, useRouterState } from '@tanstack/react-router';
import {
  HardDrive,
  Network,
  Database,
  CreditCard,
  MessageSquare,
  Shield,
  Activity,
  Key,
  Settings
} from 'lucide-react';

export function Sidebar() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const serviceItems = [
    { path: '/services/seal', label: 'Seal Storage', icon: HardDrive },
    { path: '/services/grpc', label: 'gRPC', icon: Network },
    { path: '/services/graphql', label: 'GraphQL', icon: Database },
  ];

  const managementItems = [
    { path: '/billing', label: 'Billing & Usage', icon: CreditCard },
    { path: '/api-keys', label: 'API Keys', icon: Key },
    { path: '/logs', label: 'Analytics & Logs', icon: Activity },
  ];

  const supportItems = [
    { path: '/support', label: 'Support', icon: MessageSquare },
    { path: '/settings', label: 'Settings', icon: Settings },
  ];

  const isActive = (path: string) => {
    return currentPath === path || currentPath.startsWith(path + '/');
  };

  return (
    <aside className="w-56 bg-gray-50 border-r border-gray-200 min-h-screen pt-14">
      <nav className="p-3">
        {/* Services Section */}
        <div className="mb-6">
          <div className="px-3 mb-2">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              Infrastructure
            </p>
          </div>
          <div className="space-y-0.5">
            {serviceItems.map((item) => {
              const active = isActive(item.path);
              const Icon = item.icon;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`
                    flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all no-underline
                    ${active
                      ? 'bg-blue-50 text-blue-600 font-medium border-l-2 border-blue-600 pl-2.5'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                    }
                  `}
                >
                  <Icon className={`h-4 w-4 ${active ? 'text-blue-600' : 'text-gray-400'}`} />
                  <span>{item.label}</span>
                  {item.path === '/services/seal' && active && (
                    <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded font-medium">
                      Active
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Management Section */}
        <div className="mb-6">
          <div className="px-3 mb-2">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
              Management
            </p>
          </div>
          <div className="space-y-0.5">
            {managementItems.map((item) => {
              const active = isActive(item.path);
              const Icon = item.icon;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`
                    flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all no-underline
                    ${active
                      ? 'bg-blue-50 text-blue-600 font-medium border-l-2 border-blue-600 pl-2.5'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                    }
                  `}
                >
                  <Icon className={`h-4 w-4 ${active ? 'text-blue-600' : 'text-gray-400'}`} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-gray-200 my-4 mx-3" />

        {/* Support Section */}
        <div>
          <div className="space-y-0.5">
            {supportItems.map((item) => {
              const active = isActive(item.path);
              const Icon = item.icon;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`
                    flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all no-underline
                    ${active
                      ? 'bg-blue-50 text-blue-600 font-medium border-l-2 border-blue-600 pl-2.5'
                      : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                    }
                  `}
                >
                  <Icon className={`h-4 w-4 ${active ? 'text-blue-600' : 'text-gray-400'}`} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </aside>
  );
}
