/**
 * Main entry point for React app
 * Loads frontend configuration before rendering
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { WalletProvider } from './components/wallet/WalletProvider';
import { ThemeProvider } from './components/providers/ThemeProvider';
import { routeTree } from './routeTree.gen';
import { Toaster } from 'sonner';
import { loadFrontendConfig } from './lib/config';
import './index.css';

// Create router instance
const router = createRouter({ routeTree });

// Register router for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Initialize app
async function initializeApp() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);

  // Show loading screen while config loads
  root.render(
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#6b7280'
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: '40px',
          height: '40px',
          border: '3px solid #f3f4f6',
          borderTopColor: '#f38020',
          borderRadius: '50%',
          margin: '0 auto 16px',
          animation: 'spin 1s linear infinite'
        }} />
        <p style={{ marginBottom: '8px' }}>Loading configuration from database...</p>
        <p style={{ fontSize: '12px', color: '#9ca3af' }}>
          Waiting for backend connection
        </p>
      </div>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );

  // Load configuration from backend
  await loadFrontendConfig();

  // Render app after config is loaded
  root.render(
    <React.StrictMode>
      <ThemeProvider>
        <WalletProvider>
          <Toaster position="top-center" />
          <RouterProvider router={router} />
        </WalletProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
}

// Start app
initializeApp();
