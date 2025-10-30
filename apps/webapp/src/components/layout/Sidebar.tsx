/**
 * Dashboard Sidebar
 * Matches Cloudflare cf-ui navigation design
 */

import { Link, useRouterState } from '@tanstack/react-router';

export function Sidebar() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const navItems = [
    { path: '/', label: 'Overview', icon: '📊', exact: true },
    { path: '/services', label: 'Services', icon: '⚙️' },
    { path: '/api-keys', label: 'API Keys', icon: '🔑' },
    { path: '/billing', label: 'Billing', icon: '💳' },
    { path: '/logs', label: 'Logs', icon: '📝' },
  ];

  const isActive = (path: string, exact?: boolean) => {
    if (exact) return currentPath === path;
    return currentPath === path || currentPath.startsWith(path + '/');
  };

  return (
    <aside
      className="w-56 border-r flex flex-col shrink-0 bg-white"
      style={{ borderColor: '#ebebeb' }}
    >
      <nav className="flex-1 pt-6 px-3">
        <div className="space-y-1">
          {navItems.map((item) => {
            const active = isActive(item.path, item.exact);

            return (
              <Link
                key={item.path}
                to={item.path}
                className="flex items-center gap-3 px-3 py-2 rounded transition-colors"
                style={{
                  backgroundColor: active ? 'rgba(47, 123, 191, 0.1)' : 'transparent',
                  color: active ? '#2F7BBF' : '#333333',
                  fontWeight: active ? 600 : 400,
                  fontSize: '0.86667rem', // Cloudflare small
                }}
              >
                <span className="text-lg">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}
