/**
 * Shared micro-components for standalone detail pages (Customer, Invoice).
 */

import type { CSSProperties, ReactNode } from 'react';

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function statusBadgeColor(color: string): { bg: string; text: string } {
  switch (color) {
    case 'green': return { bg: '#064e3b', text: '#34d399' };
    case 'red': return { bg: '#7f1d1d', text: '#fca5a5' };
    case 'amber': return { bg: '#78350f', text: '#fcd34d' };
    case 'blue': return { bg: '#1e3a5f', text: '#93c5fd' };
    case 'gray': return { bg: '#374151', text: '#9ca3af' };
    default: return { bg: '#374151', text: '#9ca3af' };
  }
}

// Page wrapper — standalone dark page (no Layout/sidebar)
export function Page({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', color: '#e2e8f0', padding: '1.5rem' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
        {children}
      </div>
    </div>
  );
}

// Shared styles
export const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' };
export const thRowStyle: CSSProperties = { borderBottom: '1px solid #334155' };
export const tdRowStyle: CSSProperties = { borderBottom: '1px solid #1e293b' };
export const linkStyle: CSSProperties = { color: '#60a5fa', textDecoration: 'none', fontSize: '0.8125rem' };

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: '0.5rem', marginBottom: '1rem', border: '1px solid #334155' }}>
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #334155', color: '#94a3b8', fontWeight: 600, fontSize: '0.875rem' }}>
        {title}
      </div>
      <div style={{ padding: '0.75rem 1rem' }}>{children}</div>
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return (
    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', color: '#64748b', fontWeight: 500, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  );
}

export function Td({ children, mono, style }: { children: ReactNode; mono?: boolean; style?: CSSProperties }) {
  return (
    <td style={{ padding: '0.5rem 0.75rem', color: '#94a3b8', fontFamily: mono ? 'monospace' : undefined, fontSize: mono ? '0.75rem' : undefined, ...style }}>
      {children}
    </td>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div style={{ color: '#64748b', fontSize: '0.8125rem' }}>{children}</div>;
}

export function KeyValueGrid({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.25rem 2rem' }}>
      {items.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0', borderBottom: '1px solid #1e293b' }}>
          <span style={{ color: '#64748b', fontSize: '0.8125rem' }}>{label}</span>
          <span style={{
            color: value === '—' ? '#475569' : '#e2e8f0',
            fontFamily: label.includes('Address') || label.includes('Contract') || label.includes('Stripe') ? 'monospace' : undefined,
            fontSize: label.includes('Address') ? '0.75rem' : '0.8125rem',
          }}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function NotificationList({ notifications }: { notifications: any[] }) {
  if (notifications.length === 0) {
    return <Empty>No notifications.</Empty>;
  }
  return (
    <>
      {notifications.map((n: any) => (
        <div key={n.notificationId} style={{
          padding: '0.5rem 0.75rem',
          background: '#0f172a',
          borderRadius: '0.25rem',
          borderLeft: `3px solid ${n.severity === 'error' ? '#7f1d1d' : n.severity === 'warning' ? '#78350f' : '#1e3a5f'}`,
          marginBottom: '0.375rem',
        }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.125rem' }}>
            <span style={{
              color: n.severity === 'error' ? '#ef4444' : n.severity === 'warning' ? '#f59e0b' : '#3b82f6',
              fontWeight: 700,
              textTransform: 'uppercase',
              fontSize: '0.6875rem',
            }}>
              {n.severity}
            </span>
            <span style={{ color: '#475569', fontSize: '0.6875rem' }}>{n.code}</span>
            <span style={{ color: '#64748b', fontSize: '0.6875rem', marginLeft: 'auto' }}>
              {new Date(n.createdAt).toLocaleString()}
            </span>
          </div>
          <div style={{ color: '#e2e8f0', fontSize: '0.8125rem' }}>{n.message}</div>
          {n.details && (
            <pre style={{
              color: '#94a3b8', fontSize: '0.6875rem', margin: '0.375rem 0 0',
              background: '#1e293b', padding: '0.375rem', borderRadius: '0.25rem',
              overflow: 'auto', maxHeight: '80px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {JSON.stringify(n.details, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </>
  );
}
