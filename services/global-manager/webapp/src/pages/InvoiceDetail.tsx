import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  formatCents, statusBadgeColor, Page, Section, Th, Td, Empty, KeyValueGrid, NotificationList,
  tableStyle, thRowStyle, tdRowStyle, linkStyle,
} from '../components/DetailComponents';

export function InvoiceDetail() {
  const [searchParams] = useSearchParams();
  const invoiceId = searchParams.get('id');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!invoiceId) return;
    setLoading(true);
    fetch(`/api/invoice/${invoiceId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [invoiceId]);

  if (loading) return <Page><div style={{ color: '#94a3b8' }}>Loading invoice #{invoiceId}...</div></Page>;
  if (error) return <Page><div style={{ color: '#f87171' }}>Error: {error}</div></Page>;
  if (!data) return null;

  const { invoice, customer, lineItems, paymentSources, notifications } = data;
  const badge = statusBadgeColor(invoice.color);

  return (
    <Page>
      <a href="/billing" style={{ color: '#60a5fa', fontSize: '0.8125rem', textDecoration: 'none' }}>&larr; Billing Monitor</a>

      <h2 style={{ color: '#e2e8f0', fontSize: '1.25rem', margin: '0.75rem 0', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        Invoice #{invoice.id}
        <span style={{ padding: '0.125rem 0.625rem', borderRadius: '9999px', background: badge.bg, color: badge.text, fontSize: '0.75rem', fontWeight: 600 }}>
          {invoice.displayBin}
        </span>
      </h2>

      {/* Invoice Record */}
      <Section title="Invoice Record">
        <KeyValueGrid items={[
          ['Customer', customer ? `#${customer.customerId} (${customer.walletAddress?.substring(0, 12)}...)` : String(invoice.customerId)],
          ['Amount', formatCents(invoice.amountUsdCents)],
          ['Amount Paid', formatCents(invoice.amountPaidUsdCents)],
          ['Status', invoice.status],
          ['Type', `${invoice.type} / ${invoice.billingType}`],
          ['Billing Period', `${new Date(invoice.billingPeriodStart).toLocaleDateString()} - ${new Date(invoice.billingPeriodEnd).toLocaleDateString()}`],
          ['Due Date', invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : '—'],
          ['Retry Count', String(invoice.retryCount ?? 0)],
          ['Last Retry', invoice.lastRetryAt ? new Date(invoice.lastRetryAt).toLocaleString() : '—'],
          ['Failure Reason', invoice.failureReason || '—'],
          ['3DS Action URL', invoice.paymentActionUrl ? 'Yes' : '—'],
          ['TX Digest', invoice.txDigest || '—'],
          ['Created', new Date(invoice.createdAt).toLocaleString()],
          ['Updated', invoice.lastUpdatedAt ? new Date(invoice.lastUpdatedAt).toLocaleString() : '—'],
        ]} />
        {customer && (
          <div style={{ marginTop: '0.5rem' }}>
            <a href={`/customer?id=${customer.customerId}`} target="_blank" rel="noopener noreferrer" style={linkStyle}>
              View full customer record &rarr;
            </a>
          </div>
        )}
      </Section>

      {/* Line Items */}
      <Section title={`Line Items (${lineItems.length})`}>
        {lineItems.length === 0 ? (
          <Empty>No line items.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={thRowStyle}>
                <Th>Type</Th><Th>Service</Th><Th>Qty</Th><Th>Unit Price</Th><Th>Amount</Th><Th>Description</Th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li: any) => (
                <tr key={li.lineItemId} style={tdRowStyle}>
                  <Td>{li.itemType}</Td>
                  <Td>{li.serviceType || '—'}</Td>
                  <Td>{li.quantity}</Td>
                  <Td>{formatCents(li.unitPriceUsdCents)}</Td>
                  <Td>{formatCents(li.amountUsdCents)}</Td>
                  <Td>{li.description || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Payment Sources */}
      <Section title={`Payment Sources (${paymentSources.length})`}>
        {paymentSources.length === 0 ? (
          <Empty>No payments recorded.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={thRowStyle}>
                <Th>ID</Th><Th>Source</Th><Th>Amount</Th><Th>Reference</Th><Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {paymentSources.map((ps: any) => (
                <tr key={ps.paymentId} style={tdRowStyle}>
                  <Td>{ps.paymentId}</Td>
                  <Td>{ps.type}</Td>
                  <Td>{formatCents(ps.amountCents)}</Td>
                  <Td mono>{ps.referenceId || '—'}</Td>
                  <Td>{new Date(ps.createdAt).toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Notifications */}
      <Section title={`Notifications (${notifications.length})`}>
        <NotificationList notifications={notifications} />
      </Section>
    </Page>
  );
}
