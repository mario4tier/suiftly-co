/**
 * Dashboard Sidebar
 * Cloudflare-style navigation
 */

import { useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  HardDrive,
  Network,
  Database,
  CreditCard,
  MessageSquare,
  Activity,
  Key,
  Home,
  Radio,
  type LucideIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  children?: { path: string; label: string }[];
}

// Cloudflare-style chevron SVG (filled triangle)
function ChevronUp({ className }: { className?: string }) {
  return (
    <span className="w-9 h-[42px] flex items-center justify-center transition-colors group-hover:bg-[#e5e7eb] dark:group-hover:bg-[#374151]">
      <svg
        className={className}
        role="presentation"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M8.353 4.498h-.707l-6.15 6.15.354.853h12.3l.354-.853-6.15-6.15z" />
      </svg>
    </span>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  // Track which collapsible sections are open
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    seal: true, // Default open
  });

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // Check if current path matches exactly
  const isActive = (path: string) => {
    return currentPath === path;
  };

  // Check if any child is active
  const isAnyChildActive = (children?: { path: string; label: string }[]) => {
    if (!children) return false;
    return children.some((child) => isActive(child.path));
  };

  const topItems: NavItem[] = [
    { path: '/dashboard', label: 'Dashboard', icon: Home },
  ];

  const serviceItems: NavItem[] = [
    {
      path: '/services/seal',
      label: 'Seal',
      icon: HardDrive,
      children: [
        { path: '/services/seal/config', label: 'Config' },
        { path: '/services/seal/stats', label: 'Stats' },
      ],
    },
    { path: '/services/grpc', label: 'gRPC', icon: Network },
    { path: '/services/graphql', label: 'GraphQL', icon: Database },
  ];

  const managementItems: NavItem[] = [
    { path: '/billing', label: 'Billing & Payments', icon: CreditCard },
    { path: '/api-keys', label: 'API Keys', icon: Key },
    { path: '/logs', label: 'User Logs', icon: Activity },
  ];

  const statusItems: NavItem[] = [
    { path: '/network-status', label: 'Network Status', icon: Radio },
  ];

  const supportItems: NavItem[] = [
    { path: '/support', label: 'Support', icon: MessageSquare },
  ];

  const renderNavItem = (item: NavItem, sectionKey?: string) => {
    const active = isActive(item.path);
    const hasChildren = item.children && item.children.length > 0;
    const anyChildActive = isAnyChildActive(item.children);
    const Icon = item.icon;
    const isOpen = sectionKey ? openSections[sectionKey] : false;

    if (hasChildren) {
      const handleParentClick = () => {
        // Open the section if it's not already open
        if (!isOpen && sectionKey) {
          toggleSection(sectionKey);
        }
        // Navigate to the first child
        if (item.children && item.children.length > 0) {
          navigate({ to: item.children[0].path });
        }
      };

      return (
        <Collapsible
          key={item.path}
          open={isOpen}
          onOpenChange={() => sectionKey && toggleSection(sectionKey)}
        >
          <div
            className={`
              group flex items-center gap-2 px-3 w-[231px] h-[42px] rounded-r-md text-[14px] font-normal transition-all cursor-pointer relative
              ${anyChildActive
                ? 'bg-blue-50 dark:bg-blue-900/20 text-[rgb(0,81,195)] dark:text-blue-400 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-[rgb(0,81,195)] before:rounded-r-full'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }
            `}
          >
            <div
              onClick={handleParentClick}
              className="flex items-center gap-2 flex-1"
            >
              <div className="w-[55px] h-5 flex items-center justify-center flex-shrink-0">
                <Icon className={`w-5 h-5 ${anyChildActive ? 'text-[rgb(0,81,195)]' : 'text-gray-500 dark:text-gray-400'}`} />
              </div>
              <span className="flex-1">{item.label}</span>
            </div>
            <CollapsibleTrigger asChild>
              <button className="flex items-center justify-center">
                <ChevronUp
                  className={`w-[10px] h-[10px] transition-transform fill-[#9ca3af] dark:fill-[#6b7280] ${isOpen ? '' : 'rotate-180'}`}
                />
              </button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="pl-7">
            <div className="space-y-0.5">
              {item.children?.map((child) => {
                const childActive = isActive(child.path);
                return (
                  <Link
                    key={child.path}
                    to={child.path}
                    className={`
                      flex items-center px-3 w-[231px] h-[42px] ml-1 rounded-r-md text-[14px] font-normal transition-all no-underline relative
                      ${childActive
                        ? 'bg-blue-50 dark:bg-blue-900/20 text-[rgb(0,81,195)] dark:text-blue-400 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-[rgb(0,81,195)] before:rounded-r-full'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }
                    `}
                  >
                    <span>{child.label}</span>
                  </Link>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      );
    }

    // Regular nav item without children
    return (
      <Link
        key={item.path}
        to={item.path}
        className={`
          flex items-center gap-2 px-3 w-[231px] h-[42px] rounded-r-md text-[14px] font-normal transition-all no-underline relative
          ${active
            ? 'bg-blue-50 dark:bg-blue-900/20 text-[rgb(0,81,195)] dark:text-blue-400 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-[rgb(0,81,195)] before:rounded-r-full'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
          }
        `}
      >
        <div className="w-[55px] h-5 flex items-center justify-center flex-shrink-0">
          <Icon className={`w-5 h-5 ${active ? 'text-[rgb(0,81,195)]' : 'text-gray-500 dark:text-gray-400'}`} />
        </div>
        <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <aside className="w-[255px] bg-white dark:bg-gray-900 border-r border-cf-border dark:border-cf-border-dark min-h-screen pt-1">
      <nav className="p-3 space-y-1">
        {/* Top Items (Dashboard) */}
        <div className="space-y-0.5">
          {topItems.map((item) => renderNavItem(item))}
        </div>

        {/* Infrastructure Section */}
        <div className="pt-4">
          <div className="px-3 mb-1">
            <p className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">
              Infrastructure
            </p>
          </div>
          <div className="space-y-0.5">
            {serviceItems.map((item) =>
              renderNavItem(item, item.children ? item.label.toLowerCase() : undefined)
            )}
          </div>
        </div>

        {/* Management Section */}
        <div className="pt-4">
          <div className="px-3 mb-1">
            <p className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">
              Management
            </p>
          </div>
          <div className="space-y-0.5">
            {managementItems.map((item) => renderNavItem(item))}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-cf-border dark:border-cf-border-dark my-3" />

        {/* Status Section */}
        <div className="space-y-0.5">
          {statusItems.map((item) => renderNavItem(item))}
        </div>

        {/* Support Section */}
        <div className="space-y-0.5">
          {supportItems.map((item) => renderNavItem(item))}
        </div>
      </nav>
    </aside>
  );
}
