import { useState, useEffect, useCallback } from 'react';
import { useAdminPollingContext } from '../contexts/AdminPollingContext';

// ============================================================================
// Types
// ============================================================================

interface BinData {
  count: number;
  totalCents: number;
}

interface MonthData {
  label: string;
  paid: BinData;
  pending: BinData;
  retrying: BinData;
  failedExhausted: BinData;
  awaiting3ds: BinData;
  draft: BinData;
  voided: BinData;
}

interface OverviewData {
  currentMonth: MonthData;
  previousMonth: MonthData;
  customers: {
    total: number;
    inGracePeriod: number;
    suspended: number;
    withPaymentMethod: number;
  };
  recentRefunds: BinData;
  refundFailures: { count: number };
}

interface PaymentSource {
  type: string;
  amountCents: number;
  referenceId: string | null;
}

interface LineItem {
  type: string;
  serviceType: string | null;
  amountCents: number;
  quantity: number;
  description: string | null;
}

interface Invoice {
  id: number;
  customerId: number;
  amountCents: number;
  amountPaidCents: number;
  status: string;
  displayBin: string;
  color: string;
  type: string;
  billingType: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  retryCount: number;
  lastRetryAt: string | null;
  failureReason: string | null;
  paymentActionUrl: string | null;
  createdAt: string;
  paymentSources: PaymentSource[];
  lineItems: LineItem[];
}

interface AlarmItem {
  category: string;
  type: string;
  invoiceId: number | null;
  customerId: number;
  amountCents: number;
  failureReason: string | null;
  retryCount: number;
  lastRetryAt: string | null;
  daysSinceLastRetry: number | null;
  daysSinceCreated: number | null;
  message: string;
}

interface Notification {
  notificationId: number;
  severity: string;
  category: string;
  code: string;
  message: string;
  details: any;
  customerId: string | null;
  invoiceId: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  createdAt: string;
}

// ============================================================================
// Helpers
// ============================================================================

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function alarmTypeColor(type: string): string {
  switch (type) {
    case 'failed_exhausted': return '#ef4444';
    case 'failed_stalled': return '#ef4444';
    case 'stuck_pending': return '#f59e0b';
    case 'stale_3ds': return '#f59e0b';
    case 'grace_expiring': return '#f59e0b';
    default: return '#94a3b8';
  }
}

function alarmTypeLabel(type: string): string {
  switch (type) {
    case 'failed_exhausted': return 'FAILED';
    case 'failed_stalled': return 'STALLED';
    case 'stuck_pending': return 'STUCK';
    case 'stale_3ds': return 'STALE 3DS';
    case 'grace_expiring': return 'GRACE';
    default: return type.toUpperCase();
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'error': return '#ef4444';
    case 'warning': return '#f59e0b';
    case 'info': return '#3b82f6';
    default: return '#94a3b8';
  }
}

function severityBorderColor(severity: string): string {
  switch (severity) {
    case 'error': return '#7f1d1d';
    case 'warning': return '#78350f';
    case 'info': return '#1e3a5f';
    default: return '#334155';
  }
}

function statusBadgeColor(color: string): { bg: string; text: string } {
  switch (color) {
    case 'green': return { bg: '#064e3b', text: '#34d399' };
    case 'red': return { bg: '#7f1d1d', text: '#fca5a5' };
    case 'amber': return { bg: '#78350f', text: '#fcd34d' };
    case 'blue': return { bg: '#1e3a5f', text: '#93c5fd' };
    case 'gray': return { bg: '#374151', text: '#9ca3af' };
    default: return { bg: '#374151', text: '#9ca3af' };
  }
}

function paymentSourceIcon(type: string): string {
  switch (type) {
    case 'credit': return 'C';
    case 'escrow': return 'E';
    case 'stripe': return 'S';
    case 'paypal': return 'P';
    default: return '?';
  }
}

// ============================================================================
// Component
// ============================================================================

export function BillingMonitor() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [alarms, setAlarms] = useState<AlarmItem[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<'current' | 'previous'>('current');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedInvoice, setExpandedInvoice] = useState<number | null>(null);
  const [alarmsOpen, setAlarmsOpen] = useState(true);
  const [notifsOpen, setNotifsOpen] = useState(true);

  const { pollingInterval, markUpdated } = useAdminPollingContext();

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setOverview(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch billing overview');
    }
  }, []);

  const fetchInvoices = useCallback(async () => {
    if (!overview) return;
    const month = selectedMonth === 'current'
      ? overview.currentMonth.label
      : overview.previousMonth.label;
    try {
      const params = new URLSearchParams({ month, status: statusFilter, limit: '100' });
      const res = await fetch(`/api/billing/invoices?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setInvoices(data.invoices);
    } catch (e) {
      setInvoices([]);
    }
  }, [overview, selectedMonth, statusFilter]);

  const fetchAlarms = useCallback(async () => {
    try {
      const res = await fetch('/api/alarms?category=billing');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAlarms(data.items);
    } catch {
      setAlarms([]);
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const url = showAcknowledged
        ? '/api/notifications?category=billing'
        : '/api/notifications?category=billing&acknowledged=false';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNotifications(data.notifications ?? []);
    } catch {
      setNotifications([]);
    }
  }, [showAcknowledged]);

  const acknowledgeNotification = async (id: number) => {
    await fetch(`/api/notifications/${id}/acknowledge`, { method: 'POST' });
    fetchNotifications();
  };

  const deleteNotification = async (id: number) => {
    await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
    fetchNotifications();
  };

  const acknowledgeAllBilling = async () => {
    await fetch('/api/notifications/acknowledge-all?category=billing', { method: 'POST' });
    fetchNotifications();
  };

  // Periodic fetch on adaptive polling interval.
  // Alarms are re-evaluated from live DB state on every poll — they appear/disappear
  // automatically as conditions change. Notifications are persisted and require manual
  // dismiss, so they only change when the user takes action or new ones are created.
  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      await Promise.all([fetchOverview(), fetchAlarms(), fetchNotifications()]);
      markUpdated();
      setLoading(false);
    };
    fetchAll();
    const interval = setInterval(fetchAll, pollingInterval);
    return () => clearInterval(interval);
  }, [fetchOverview, fetchAlarms, fetchNotifications, pollingInterval, markUpdated]);

  // Fetch invoices when filters change
  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  // Auto-open cards when items appear
  useEffect(() => {
    if (alarms.length > 0) setAlarmsOpen(true);
  }, [alarms.length]);

  const unacknowledgedCount = notifications.filter(n => !n.acknowledged).length;
  useEffect(() => {
    if (unacknowledgedCount > 0) setNotifsOpen(true);
  }, [unacknowledgedCount]);

  if (loading && !overview) {
    return <div style={{ color: '#94a3b8', padding: '2rem' }}>Loading billing data...</div>;
  }

  if (error && !overview) {
    return <div style={{ color: '#f87171', padding: '2rem' }}>Error: {error}</div>;
  }

  const monthData = selectedMonth === 'current'
    ? overview?.currentMonth
    : overview?.previousMonth;

  const unacknowledgedNotifs = notifications.filter(n => !n.acknowledged);

  return (
    <div style={{ maxWidth: '1100px' }}>
      {/* Summary Cards Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '0.75rem',
        marginBottom: '1.5rem',
      }}>
        <SummaryCard label="Collected" count={monthData?.paid.count ?? 0} amount={monthData?.paid.totalCents ?? 0} borderColor="#22c55e" />
        <SummaryCard label="Processing" count={monthData?.pending.count ?? 0} amount={monthData?.pending.totalCents ?? 0} borderColor="#3b82f6" />
        <SummaryCard label="Retrying" count={monthData?.retrying.count ?? 0} amount={monthData?.retrying.totalCents ?? 0} borderColor="#f59e0b" />
        <SummaryCard label="Failed" count={monthData?.failedExhausted.count ?? 0} amount={monthData?.failedExhausted.totalCents ?? 0} borderColor="#ef4444" />
        <SummaryCard label="3DS Waiting" count={monthData?.awaiting3ds.count ?? 0} amount={monthData?.awaiting3ds.totalCents ?? 0} borderColor="#f59e0b" />
        <SummaryCard label="Projected" count={monthData?.draft.count ?? 0} amount={monthData?.draft.totalCents ?? 0} borderColor="#6b7280" />
      </div>

      {/* Customer Stats Row */}
      {overview && (
        <div style={{
          display: 'flex',
          gap: '1.5rem',
          marginBottom: '1.5rem',
          padding: '0.75rem 1rem',
          background: '#1e293b',
          borderRadius: '0.5rem',
          fontSize: '0.8125rem',
          color: '#94a3b8',
        }}>
          <span>Customers: <strong style={{ color: '#e2e8f0' }}>{overview.customers.total}</strong></span>
          <span>With Payment: <strong style={{ color: '#e2e8f0' }}>{overview.customers.withPaymentMethod}</strong></span>
          <span>Grace Period: <strong style={{ color: overview.customers.inGracePeriod > 0 ? '#f59e0b' : '#e2e8f0' }}>{overview.customers.inGracePeriod}</strong></span>
          <span>Suspended: <strong style={{ color: overview.customers.suspended > 0 ? '#ef4444' : '#e2e8f0' }}>{overview.customers.suspended}</strong></span>
          {overview.recentRefunds.count > 0 && (
            <span>Refunds: <strong style={{ color: '#e2e8f0' }}>{overview.recentRefunds.count} ({formatCents(overview.recentRefunds.totalCents)})</strong></span>
          )}
          {overview.refundFailures.count > 0 && (
            <span>Refund Failures: <strong style={{ color: '#ef4444' }}>{overview.refundFailures.count}</strong></span>
          )}
        </div>
      )}

      {/* Month Selector */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button
          onClick={() => setSelectedMonth('current')}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '0.375rem',
            border: '1px solid #334155',
            background: selectedMonth === 'current' ? '#1e3a5f' : '#1e293b',
            color: selectedMonth === 'current' ? '#60a5fa' : '#94a3b8',
            cursor: 'pointer',
            fontSize: '0.8125rem',
            fontWeight: selectedMonth === 'current' ? 600 : 400,
          }}
        >
          {overview?.currentMonth.label ?? 'Current'}
        </button>
        <button
          onClick={() => setSelectedMonth('previous')}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '0.375rem',
            border: '1px solid #334155',
            background: selectedMonth === 'previous' ? '#1e3a5f' : '#1e293b',
            color: selectedMonth === 'previous' ? '#60a5fa' : '#94a3b8',
            cursor: 'pointer',
            fontSize: '0.8125rem',
            fontWeight: selectedMonth === 'previous' ? 600 : 400,
          }}
        >
          {overview?.previousMonth.label ?? 'Previous'}
        </button>
      </div>

      {/* Alarms Card (self-clearing — no action buttons) */}
      <div style={{
        background: '#1e293b',
        borderRadius: '0.5rem',
        marginBottom: '1rem',
        border: alarms.length > 0 ? '1px solid #7f1d1d' : '1px solid #334155',
      }}>
        <button
          onClick={() => setAlarmsOpen(!alarmsOpen)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1rem',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: alarms.length > 0 ? '#fca5a5' : '#94a3b8',
            fontSize: '0.875rem',
            fontWeight: 600,
          }}
        >
          <span>
            Alarms
            <span style={{ fontWeight: 400, fontSize: '0.75rem', marginLeft: '0.5rem', color: '#64748b' }}>
              (self-clearing)
            </span>
            {alarms.length > 0 && (
              <span style={{
                marginLeft: '0.5rem',
                padding: '0.125rem 0.5rem',
                borderRadius: '9999px',
                background: '#7f1d1d',
                color: '#fca5a5',
                fontSize: '0.75rem',
              }}>
                {alarms.length}
              </span>
            )}
          </span>
          <span style={{ fontSize: '0.75rem' }}>{alarmsOpen ? '\u25B2' : '\u25BC'}</span>
        </button>

        {alarmsOpen && (
          <div style={{ padding: '0 1rem 0.75rem' }}>
            {alarms.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '0.8125rem' }}>
                No active alarms.
              </div>
            ) : (
              alarms.map((item, idx) => (
                <div
                  key={`alarm-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '0.5rem 0',
                    borderTop: idx === 0 ? 'none' : '1px solid #334155',
                  }}
                >
                  <span style={{
                    padding: '0.125rem 0.375rem',
                    borderRadius: '0.25rem',
                    background: alarmTypeColor(item.type) + '22',
                    color: alarmTypeColor(item.type),
                    fontSize: '0.6875rem',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}>
                    {alarmTypeLabel(item.type)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#e2e8f0', fontSize: '0.8125rem' }}>{item.message}</div>
                    <div style={{ color: '#64748b', fontSize: '0.75rem', marginTop: '0.125rem' }}>
                      Customer {item.customerId}
                      {item.amountCents > 0 && <> &middot; {formatCents(item.amountCents)}</>}
                      {item.daysSinceLastRetry !== null && <> &middot; {item.daysSinceLastRetry}d since last retry</>}
                      {item.daysSinceLastRetry === null && item.daysSinceCreated !== null && <> &middot; {item.daysSinceCreated}d since created</>}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Notifications Card (persistent — can be dismissed/deleted) */}
      <div style={{
        background: '#1e293b',
        borderRadius: '0.5rem',
        marginBottom: '1rem',
        border: unacknowledgedNotifs.length > 0 ? '1px solid #78350f' : '1px solid #334155',
      }}>
        <button
          onClick={() => setNotifsOpen(!notifsOpen)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1rem',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: unacknowledgedNotifs.length > 0 ? '#fcd34d' : '#94a3b8',
            fontSize: '0.875rem',
            fontWeight: 600,
          }}
        >
          <span>
            Notifications
            {unacknowledgedNotifs.length > 0 && (
              <span style={{
                marginLeft: '0.5rem',
                padding: '0.125rem 0.5rem',
                borderRadius: '9999px',
                background: '#78350f',
                color: '#fcd34d',
                fontSize: '0.75rem',
              }}>
                {unacknowledgedNotifs.length}
              </span>
            )}
          </span>
          <span style={{ fontSize: '0.75rem' }}>{notifsOpen ? '\u25B2' : '\u25BC'}</span>
        </button>

        {notifsOpen && (
          <div style={{ padding: '0 1rem 0.75rem' }}>
            {/* Action bar */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '0.5rem',
            }}>
              <label style={{ color: '#64748b', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showAcknowledged}
                  onChange={(e) => setShowAcknowledged(e.target.checked)}
                />
                Show acknowledged
              </label>
              {unacknowledgedNotifs.length > 0 && (
                <button
                  onClick={acknowledgeAllBilling}
                  style={{
                    background: '#3b82f6',
                    color: 'white',
                    border: 'none',
                    padding: '0.25rem 0.625rem',
                    borderRadius: '0.25rem',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                  }}
                >
                  Acknowledge All
                </button>
              )}
            </div>

            {notifications.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '0.8125rem' }}>
                No billing notifications.
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.notificationId}
                  style={{
                    background: n.acknowledged ? '#0f172a' : '#1e3a5f22',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.25rem',
                    borderLeft: `3px solid ${severityBorderColor(n.severity)}`,
                    marginBottom: '0.375rem',
                    opacity: n.acknowledged ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.125rem' }}>
                        <span style={{
                          color: severityColor(n.severity),
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          fontSize: '0.6875rem',
                        }}>
                          {n.severity}
                        </span>
                        <span style={{ color: '#475569', fontSize: '0.6875rem' }}>{n.code}</span>
                      </div>
                      <div style={{ color: '#e2e8f0', fontSize: '0.8125rem' }}>{n.message}</div>
                      {n.details && (
                        <pre style={{
                          color: '#94a3b8',
                          fontSize: '0.6875rem',
                          margin: '0.375rem 0 0',
                          background: '#0f172a',
                          padding: '0.375rem',
                          borderRadius: '0.25rem',
                          overflow: 'auto',
                          maxHeight: '80px',
                          maxWidth: '100%',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}>
                          {JSON.stringify(n.details, null, 2)}
                        </pre>
                      )}
                      <div style={{ color: '#475569', fontSize: '0.6875rem', marginTop: '0.125rem' }}>
                        {new Date(n.createdAt).toLocaleString()}
                        {n.customerId && ` | Customer: ${n.customerId}`}
                        {n.invoiceId && ` | Invoice: ${n.invoiceId}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0, marginLeft: '0.5rem' }}>
                      {!n.acknowledged && (
                        <button
                          onClick={() => acknowledgeNotification(n.notificationId)}
                          style={{
                            background: '#22c55e',
                            color: 'white',
                            border: 'none',
                            padding: '0.125rem 0.5rem',
                            borderRadius: '0.25rem',
                            cursor: 'pointer',
                            fontSize: '0.6875rem',
                          }}
                        >
                          Dismiss
                        </button>
                      )}
                      <button
                        onClick={() => deleteNotification(n.notificationId)}
                        style={{
                          background: '#64748b',
                          color: 'white',
                          border: 'none',
                          padding: '0.125rem 0.5rem',
                          borderRadius: '0.25rem',
                          cursor: 'pointer',
                          fontSize: '0.6875rem',
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Invoice Table */}
      <div style={{
        background: '#1e293b',
        borderRadius: '0.5rem',
        border: '1px solid #334155',
      }}>
        {/* Status Filter Buttons */}
        <div style={{
          display: 'flex',
          gap: '0.25rem',
          padding: '0.75rem 1rem',
          borderBottom: '1px solid #334155',
          flexWrap: 'wrap',
        }}>
          {(['all', 'paid', 'pending', 'failed', 'draft', 'voided'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                padding: '0.25rem 0.625rem',
                borderRadius: '0.25rem',
                border: '1px solid #334155',
                background: statusFilter === s ? '#334155' : 'transparent',
                color: statusFilter === s ? '#e2e8f0' : '#64748b',
                cursor: 'pointer',
                fontSize: '0.75rem',
                textTransform: 'capitalize',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.8125rem',
          }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #334155' }}>
                {['Invoice', 'Customer', 'Amount', 'Status', 'Paid Via', 'Retry', 'Created'].map(h => (
                  <th
                    key={h}
                    style={{
                      padding: '0.5rem 0.75rem',
                      textAlign: 'left',
                      color: '#64748b',
                      fontWeight: 500,
                      fontSize: '0.75rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: '1.5rem', textAlign: 'center', color: '#64748b' }}>
                    No invoices found.
                  </td>
                </tr>
              ) : (
                invoices.map(inv => {
                  const badge = statusBadgeColor(inv.color);
                  const isExpanded = expandedInvoice === inv.id;
                  return (
                    <InvoiceRow
                      key={inv.id}
                      invoice={inv}
                      badge={badge}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedInvoice(isExpanded ? null : inv.id)}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function SummaryCard({ label, count, amount, borderColor }: {
  label: string;
  count: number;
  amount: number;
  borderColor: string;
}) {
  return (
    <div style={{
      background: '#1e293b',
      padding: '0.75rem 1rem',
      borderRadius: '0.5rem',
      borderLeft: `3px solid ${borderColor}`,
    }}>
      <div style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ color: '#e2e8f0', fontSize: '1.25rem', fontWeight: 700 }}>{count}</div>
      <div style={{ color: '#64748b', fontSize: '0.75rem' }}>{formatCents(amount)}</div>
    </div>
  );
}

function InvoiceRow({ invoice: inv, badge, isExpanded, onToggle }: {
  invoice: Invoice;
  badge: { bg: string; text: string };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          borderBottom: '1px solid #334155',
          cursor: 'pointer',
          background: isExpanded ? '#0f172a' : 'transparent',
        }}
        onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = '#1a2540'; }}
        onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
      >
        <td style={{ padding: '0.5rem 0.75rem', color: '#e2e8f0', whiteSpace: 'nowrap' }}>
          #{inv.id}
        </td>
        <td style={{ padding: '0.5rem 0.75rem', color: '#94a3b8' }}>
          {inv.customerId}
        </td>
        <td style={{ padding: '0.5rem 0.75rem', color: '#e2e8f0', whiteSpace: 'nowrap' }}>
          {formatCents(inv.amountCents)}
        </td>
        <td style={{ padding: '0.5rem 0.75rem' }}>
          <span style={{
            padding: '0.125rem 0.5rem',
            borderRadius: '9999px',
            background: badge.bg,
            color: badge.text,
            fontSize: '0.6875rem',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}>
            {inv.displayBin}
          </span>
        </td>
        <td style={{ padding: '0.5rem 0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {inv.paymentSources.map((ps, i) => (
              <span
                key={i}
                title={`${ps.type}: ${formatCents(ps.amountCents)}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '18px',
                  height: '18px',
                  borderRadius: '0.25rem',
                  background: '#334155',
                  color: '#94a3b8',
                  fontSize: '0.625rem',
                  fontWeight: 700,
                }}
              >
                {paymentSourceIcon(ps.type)}
              </span>
            ))}
          </div>
        </td>
        <td style={{ padding: '0.5rem 0.75rem', color: inv.retryCount > 0 ? '#f59e0b' : '#64748b' }}>
          {inv.retryCount > 0 ? inv.retryCount : '-'}
        </td>
        <td style={{ padding: '0.5rem 0.75rem', color: '#64748b', whiteSpace: 'nowrap', fontSize: '0.75rem' }}>
          {new Date(inv.createdAt).toLocaleDateString()}
        </td>
      </tr>

      {/* Expanded Detail */}
      {isExpanded && (
        <tr>
          <td colSpan={7} style={{ padding: 0 }}>
            <div style={{
              padding: '0.75rem 1.5rem',
              background: '#0f172a',
              borderBottom: '1px solid #334155',
            }}>
              <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                {/* Line Items */}
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ color: '#64748b', fontSize: '0.6875rem', fontWeight: 600, marginBottom: '0.375rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Line Items
                  </div>
                  {inv.lineItems.length === 0 ? (
                    <div style={{ color: '#475569', fontSize: '0.75rem' }}>No line items</div>
                  ) : (
                    inv.lineItems.map((li, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.125rem' }}>
                        <span>{li.type}{li.serviceType ? ` (${li.serviceType})` : ''}{li.description ? ` - ${li.description}` : ''}</span>
                        <span style={{ color: '#e2e8f0', marginLeft: '1rem' }}>{formatCents(li.amountCents)}</span>
                      </div>
                    ))
                  )}
                </div>

                {/* Payment Sources */}
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ color: '#64748b', fontSize: '0.6875rem', fontWeight: 600, marginBottom: '0.375rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Payment Sources
                  </div>
                  {inv.paymentSources.length === 0 ? (
                    <div style={{ color: '#475569', fontSize: '0.75rem' }}>No payments recorded</div>
                  ) : (
                    inv.paymentSources.map((ps, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '0.75rem', marginBottom: '0.125rem' }}>
                        <span>{ps.type}{ps.referenceId ? ` (${ps.referenceId.substring(0, 20)}...)` : ''}</span>
                        <span style={{ color: '#e2e8f0', marginLeft: '1rem' }}>{formatCents(ps.amountCents)}</span>
                      </div>
                    ))
                  )}
                </div>

                {/* Metadata */}
                <div style={{ minWidth: '180px' }}>
                  <div style={{ color: '#64748b', fontSize: '0.6875rem', fontWeight: 600, marginBottom: '0.375rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Details
                  </div>
                  <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
                    <div>Type: {inv.type} / {inv.billingType}</div>
                    <div>Period: {new Date(inv.billingPeriodStart).toLocaleDateString()} - {new Date(inv.billingPeriodEnd).toLocaleDateString()}</div>
                    <div>Paid: {formatCents(inv.amountPaidCents)} / {formatCents(inv.amountCents)}</div>
                    {inv.failureReason && <div style={{ color: '#f87171' }}>Reason: {inv.failureReason}</div>}
                    {inv.lastRetryAt && <div>Last retry: {new Date(inv.lastRetryAt).toLocaleString()}</div>}
                  </div>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
