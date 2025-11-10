/**
 * Dashboard Sidebar
 * Cloudflare-style navigation
 */

import { useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Shield,
  Network,
  Database,
  CreditCard,
  MessageSquare,
  List,
  KeyRound,
  Home,
  Radio,
  type LucideIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  badge?: { text: string; variant: 'new' | 'beta' };
  children?: { path: string; label: string; badge?: { text: string; variant: 'new' | 'beta' } }[];
}

// Badge component for sidebar items
function Badge({ text, variant }: { text: string; variant: 'new' | 'beta' }) {
  const styles = variant === 'new'
    ? 'bg-[#dbeafe] dark:bg-blue-900/30 text-[#0051c3] dark:text-blue-400'
    : 'bg-[#fed7aa] dark:bg-orange-900/30 text-[#c2410c] dark:text-orange-400';

  return (
    <span className={`ml-2 px-2 py-0.5 text-[11px] font-medium rounded ${styles}`}>
      {text}
    </span>
  );
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

  const topItems: NavItem[] = [
    { path: '/dashboard', label: 'Dashboard', icon: Home },
  ];

  const serviceItems: NavItem[] = [
    {
      path: '/services/seal',
      label: 'Seal',
      icon: Shield,
      children: [
        { path: '/services/seal/overview', label: 'Overview' },
        { path: '/services/seal/stats', label: 'Stats' },
      ],
    },
    { path: '/services/grpc', label: 'gRPC', icon: Network },
    { path: '/services/graphql', label: 'GraphQL', icon: Database },
  ];

  const managementItems: NavItem[] = [
    { path: '/billing', label: 'Billing & Payments', icon: CreditCard },
    { path: '/api-keys', label: 'API Keys', icon: KeyRound },
    { path: '/logs', label: 'Activity Logs', icon: List },
  ];

  const statusItems: NavItem[] = [
    { path: '/status', label: 'Network Status', icon: Radio },
  ];

  const supportItems: NavItem[] = [
    { path: '/support', label: 'Support', icon: MessageSquare },
  ];

  const renderNavItem = (item: NavItem, sectionKey?: string) => {
    const active = isActive(item.path);
    const hasChildren = item.children && item.children.length > 0;
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
          <div className="flex items-center h-[42px] text-[14px] font-normal relative">
            <button
              onClick={handleParentClick}
              className="sidebar-hover flex items-center flex-1 cursor-pointer transition-all hover:bg-[#e0f2f1] hover:rounded-l-full text-gray-900 dark:text-gray-100 absolute inset-0 group border-0 bg-transparent text-left"
            >
              <div className="w-[55px] h-5 flex items-center justify-center flex-shrink-0">
                <Icon className="w-5 h-5 text-[rgb(0,81,195)] dark:text-blue-400" />
              </div>
              <span className="flex-1 group-hover:underline group-hover:decoration-dotted group-hover:decoration-1 group-hover:underline-offset-2">{item.label}</span>
            </button>
            <CollapsibleTrigger asChild>
              <button className="relative z-20 flex items-center justify-center w-9 h-9 ml-auto cursor-pointer transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 rounded border-0 bg-transparent">
                <ChevronUp
                  className={`w-[10px] h-[10px] transition-transform fill-[#9ca3af] dark:fill-[#6b7280] ${isOpen ? '' : 'rotate-180'}`}
                />
              </button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="pl-7">
            <div>
              {item.children?.map((child) => {
                const childActive = isActive(child.path);
                return (
                  <Link
                    key={child.path}
                    to={child.path}
                    className={`
                      flex items-center justify-between pl-[26px] h-[28px] ml-1 text-[14px] transition-all no-underline relative group
                      ${childActive
                        ? 'sidebar-active bg-[#dbeafe] text-[rgb(0,81,195)] dark:text-blue-400 border-t border-b border-l border-[#93c5fd] dark:border-blue-700 rounded-l-full font-bold'
                        : 'sidebar-hover text-gray-900 dark:text-gray-100 hover:bg-[#e0f2f1] hover:rounded-l-full font-normal'
                      }
                    `}
                  >
                    <span className="group-hover:underline group-hover:decoration-dotted group-hover:decoration-1 group-hover:underline-offset-2">{child.label}</span>
                    {child.badge && <Badge text={child.badge.text} variant={child.badge.variant} />}
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
          flex items-center justify-between h-[42px] text-[14px] transition-all no-underline relative group
          ${active
            ? 'sidebar-active bg-[#dbeafe] text-[rgb(0,81,195)] dark:text-blue-400 border-t border-b border-l border-[#93c5fd] dark:border-blue-700 rounded-l-full font-bold'
            : 'sidebar-hover text-gray-900 dark:text-gray-100 hover:bg-[#e0f2f1] hover:rounded-l-full font-normal'
          }
        `}
      >
        <div className="flex items-center">
          <div className="w-[55px] h-5 flex items-center justify-center flex-shrink-0">
            <Icon className="w-5 h-5 text-[rgb(0,81,195)] dark:text-blue-400" />
          </div>
          <span className="group-hover:underline group-hover:decoration-dotted group-hover:decoration-1 group-hover:underline-offset-2">{item.label}</span>
        </div>
        {item.badge && <Badge text={item.badge.text} variant={item.badge.variant} />}
      </Link>
    );
  };

  return (
    <aside className="w-[255px] bg-white dark:bg-gray-900 border-r border-cf-border dark:border-cf-border-dark min-h-screen pt-1">
      <nav className="space-y-1">
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
