import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AdminPollingProvider } from './contexts/AdminPollingContext';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { KVCryptDebug } from './pages/KVCryptDebug';

function App() {
  return (
    <BrowserRouter>
      <AdminPollingProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/kvcrypt" element={<KVCryptDebug />} />
          </Routes>
        </Layout>
      </AdminPollingProvider>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
