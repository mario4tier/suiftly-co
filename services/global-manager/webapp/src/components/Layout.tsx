import { ReactNode, useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAdminPollingContext } from '../contexts/AdminPollingContext';

interface LayoutProps {
  children: ReactNode;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { path: '/infra', label: 'Infra Stats', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  { path: '/kvcrypt', label: 'KVCrypt Debug', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
];

function NavIcon({ d }: { d: string }) {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const { lastUpdate, pollingInterval } = useAdminPollingContext();
  const [timeAgo, setTimeAgo] = useState(lastUpdate ? formatTimeAgo(lastUpdate) : '');

  // Update the "time ago" display every second
  useEffect(() => {
    if (!lastUpdate) return;
    setTimeAgo(formatTimeAgo(lastUpdate));
    const timer = setInterval(() => {
      setTimeAgo(formatTimeAgo(lastUpdate));
    }, 1000);
    return () => clearInterval(timer);
  }, [lastUpdate]);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0f172a' }}>
      {/* Sidebar */}
      <aside style={{
        width: '220px',
        background: '#1e293b',
        borderRight: '1px solid #334155',
        padding: '1rem 0',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Logo */}
        <div style={{ padding: '0 1rem 1rem', borderBottom: '1px solid #334155', marginBottom: '1rem' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 'bold', color: '#60a5fa', margin: 0 }}>
            Suiftly Admin
          </h1>
          <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0.25rem 0 0' }}>
            Global Manager
          </p>
        </div>

        {/* Navigation */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', padding: '0 0.5rem' }}>
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.625rem 0.75rem',
                  borderRadius: '0.375rem',
                  textDecoration: 'none',
                  fontSize: '0.875rem',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? '#60a5fa' : '#94a3b8',
                  background: isActive ? '#1e3a5f' : 'transparent',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = '#334155';
                    e.currentTarget.style.color = '#e2e8f0';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = '#94a3b8';
                  }
                }}
              >
                <NavIcon d={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer with update status */}
        <div style={{
          marginTop: 'auto',
          padding: '1rem',
          borderTop: '1px solid #334155',
          fontSize: '0.75rem',
          color: '#64748b',
        }}>
          {lastUpdate && (
            <div style={{ marginBottom: '0.25rem' }}>
              Updated {timeAgo}
            </div>
          )}
          {pollingInterval !== undefined && (
            <div>
              Polling: {pollingInterval < 1000 ? `${pollingInterval}ms` : `${pollingInterval / 1000}s`}
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <header style={{
          height: '56px',
          background: '#1e293b',
          borderBottom: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 1.5rem',
        }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 500, color: '#e2e8f0', margin: 0 }}>
            {navItems.find(item => item.path === location.pathname)?.label || 'Admin'}
          </h2>
          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
            Development Mode
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, padding: '1.5rem', overflow: 'auto' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
