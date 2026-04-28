import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AdminPollingProvider } from './contexts/AdminPollingContext';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { InfraStats } from './pages/InfraStats';
import { KVCryptDebug } from './pages/KVCryptDebug';
import { BillingMonitor } from './pages/BillingMonitor';
import { CustomerDetail } from './pages/CustomerDetail';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { Upgrades } from './pages/Upgrades';
import { CheckpointStats } from './pages/CheckpointStats';
import { Certs } from './pages/Certs';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Standalone detail pages — no sidebar, no polling */}
        <Route path="/customer" element={<CustomerDetail />} />
        <Route path="/invoice" element={<InvoiceDetail />} />

        {/* Main dashboard pages with Layout + polling */}
        <Route path="/*" element={
          <AdminPollingProvider>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/billing" element={<BillingMonitor />} />
                <Route path="/infra" element={<InfraStats />} />
                <Route path="/kvcrypt" element={<KVCryptDebug />} />
                <Route path="/upgrades" element={<Upgrades />} />
                <Route path="/checkpoints" element={<CheckpointStats />} />
                <Route path="/certs" element={<Certs />} />
              </Routes>
            </Layout>
          </AdminPollingProvider>
        } />
      </Routes>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
