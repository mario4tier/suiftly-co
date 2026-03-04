import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  formatCents, statusBadgeColor, Page, Section, Th, Td, Empty, KeyValueGrid, NotificationList,
  tableStyle, thRowStyle, tdRowStyle, linkStyle,
} from '../components/DetailComponents';

export function CustomerDetail() {
  const [searchParams] = useSearchParams();
  const customerId = searchParams.get('id');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!customerId) return;
    setLoading(true);
    fetch(`/api/customer/${customerId}`)
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
  }, [customerId]);

  if (loading) return <Page><div style={{ color: '#94a3b8' }}>Loading customer {customerId}...</div></Page>;
  if (error) return <Page><div style={{ color: '#f87171' }}>Error: {error}</div></Page>;
  if (!data) return null;

  const { customer, paymentMethods, services, invoices, notifications, escrowTransactions } = data;

  return (
    <Page>

      <h2 style={{ color: '#e2e8f0', fontSize: '1.25rem', margin: '0.75rem 0' }}>
        Customer #{customer.customerId}
      </h2>

      {/* Customer Info */}
      <Section title="Customer Record">
        <KeyValueGrid items={[
          ['Wallet Address', customer.walletAddress],
          ['Status', customer.status],
          ['Stripe Customer ID', customer.stripeCustomerId || '—'],
          ['Escrow Contract', customer.escrowContractId || '—'],
          ['Paid Once', String(customer.paidOnce)],
          ['Spending Limit', formatCents(customer.spendingLimitUsdCents)],
          ['Current Balance', formatCents(customer.currentBalanceUsdCents)],
          ['Period Charged', formatCents(customer.currentPeriodChargedUsdCents)],
          ['Period Start', customer.currentPeriodStart ? new Date(customer.currentPeriodStart).toLocaleDateString() : '—'],
          ['Grace Period Start', customer.gracePeriodStart ? new Date(customer.gracePeriodStart).toLocaleString() : '—'],
          ['Created', new Date(customer.createdAt).toLocaleString()],
          ['Updated', new Date(customer.updatedAt).toLocaleString()],
        ]} />
      </Section>

      {/* Payment Methods */}
      <Section title={`Payment Methods (${paymentMethods.length})`}>
        {paymentMethods.length === 0 ? (
          <Empty>No payment methods configured.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={thRowStyle}>
                <Th>Priority</Th><Th>Provider</Th><Th>Status</Th><Th>Ref</Th><Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {paymentMethods.map((pm: any) => (
                <tr key={pm.id} style={tdRowStyle}>
                  <Td>{pm.priority}</Td>
                  <Td>{pm.providerType}</Td>
                  <Td>{pm.status}</Td>
                  <Td mono>{pm.providerRef || '—'}</Td>
                  <Td>{new Date(pm.createdAt).toLocaleDateString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Service Instances */}
      <Section title={`Services (${services.length})`}>
        {services.length === 0 ? (
          <Empty>No services.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={thRowStyle}>
                <Th>Service</Th><Th>Tier</Th><Th>State</Th><Th>Enabled</Th><Th>Pending Invoice</Th><Th>Paid Once</Th><Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {services.map((s: any) => (
                <tr key={s.instanceId} style={tdRowStyle}>
                  <Td>{s.serviceType}</Td>
                  <Td>{s.tier}</Td>
                  <Td>{s.state}</Td>
                  <Td>{String(s.isUserEnabled)}</Td>
                  <Td>
                    {s.subPendingInvoiceId ? (
                      <a href={`/invoice?id=${s.subPendingInvoiceId}`} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                        #{s.subPendingInvoiceId}
                      </a>
                    ) : '—'}
                  </Td>
                  <Td>{String(s.paidOnce)}</Td>
                  <Td>{new Date(s.updatedAt).toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Invoices */}
      <Section title={`Invoices (${invoices.length})`}>
        {invoices.length === 0 ? (
          <Empty>No invoices.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={thRowStyle}>
                <Th>ID</Th><Th>Amount</Th><Th>Paid</Th><Th>Status</Th><Th>Type</Th><Th>Period</Th><Th>Retry</Th><Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv: any) => {
                const badge = statusBadgeColor(inv.color);
                return (
                  <tr key={inv.id} style={tdRowStyle}>
                    <Td>
                      <a href={`/invoice?id=${inv.id}`} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                        #{inv.id}
                      </a>
                    </Td>
                    <Td>{formatCents(inv.amountUsdCents)}</Td>
                    <Td>{formatCents(inv.amountPaidUsdCents)}</Td>
                    <Td>
                      <span style={{ padding: '0.125rem 0.5rem', borderRadius: '9999px', background: badge.bg, color: badge.text, fontSize: '0.6875rem', fontWeight: 600 }}>
                        {inv.displayBin}
                      </span>
                    </Td>
                    <Td>{inv.type} / {inv.billingType}</Td>
                    <Td style={{ fontSize: '0.75rem' }}>
                      {new Date(inv.billingPeriodStart).toLocaleDateString()} - {new Date(inv.billingPeriodEnd).toLocaleDateString()}
                    </Td>
                    <Td>
                      {inv.retryCount > 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                          {inv.retryCount}
                          <button
                            onClick={async () => {
                              await fetch(`/api/invoice/${inv.id}/reset-retry`, { method: 'POST' });
                              const res = await fetch(`/api/customer/${customerId}`);
                              if (res.ok) setData(await res.json());
                            }}
                            style={{
                              background: '#f59e0b', color: '#000', border: 'none',
                              padding: '0.125rem 0.375rem', borderRadius: '0.25rem',
                              cursor: 'pointer', fontSize: '0.625rem', fontWeight: 600,
                            }}
                          >
                            Reset
                          </button>
                        </span>
                      ) : '—'}
                    </Td>
                    <Td>{new Date(inv.createdAt).toLocaleDateString()}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {/* Escrow Transactions */}
      <Section title={`Escrow Transactions (${escrowTransactions.length})`}>
        {escrowTransactions.length === 0 ? (
          <Empty>No escrow transactions.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={thRowStyle}>
                <Th>ID</Th><Th>Type</Th><Th>Amount</Th><Th>Asset</Th><Th>TX Digest</Th><Th>Time</Th>
              </tr>
            </thead>
            <tbody>
              {escrowTransactions.map((tx: any) => (
                <tr key={tx.txId} style={tdRowStyle}>
                  <Td>{tx.txId}</Td>
                  <Td>{tx.txType}</Td>
                  <Td>${Number(tx.amountUsd).toFixed(2)}</Td>
                  <Td>{tx.assetType}</Td>
                  <Td mono>{tx.txDigest ? `${tx.txDigest.substring(0, 16)}...` : '—'}</Td>
                  <Td>{new Date(tx.timestamp).toLocaleString()}</Td>
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
