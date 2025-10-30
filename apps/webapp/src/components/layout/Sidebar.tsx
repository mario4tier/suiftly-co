/**
 * Dashboard Sidebar
 * Clean navigation with Tailwind CSS
 */

import { Link, useRouterState } from '@tanstack/react-router';

export function Sidebar() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const serviceItems = [
    { path: '/services/seal', label: 'Seal', icon: '🔷' },
    { path: '/services/grpc', label: 'gRPC', icon: '🌐' },
    { path: '/services/graphql', label: 'GraphQL', icon: '📊' },
  ];

  const accountItems = [
    { path: '/billing', label: 'Billing', icon: '💳' },
    { path: '/support', label: 'Support', icon: '💬' },
  ];

  const isActive = (path: string, exact?: boolean) => {
    if (exact) return currentPath === path;
    return currentPath === path || currentPath.startsWith(path + '/');
  };

  return (
    <aside className="w-64 bg-white border-r border-border h-screen sticky top-0">
      <nav className="p-4">
        {/* Services Section */}
        <div className="mb-6">
          <div className="px-3 mb-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Services
            </p>
          </div>
          <div className="space-y-1">
            {serviceItems.map((item) => {
              const active = isActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`
                    flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors no-underline
                    ${active
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-secondary'
                    }
                  `}
                >
                  <span className="text-base">{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-border my-4" />

        {/* Account Section */}
        <div>
          <div className="space-y-1">
            {accountItems.map((item) => {
              const active = isActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`
                    flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors no-underline
                    ${active
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-secondary'
                    }
                  `}
                >
                  <span className="text-base">{item.icon}</span>
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
