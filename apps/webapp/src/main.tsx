/**
 * Main entry point for React app
 * Phase 7: With Wallet Provider
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { WalletProvider } from './components/wallet/WalletProvider';
import { ThemeProvider } from './components/providers/ThemeProvider';
import { routeTree } from './routeTree.gen';
import { Toaster } from 'sonner';
import './index.css';

// Create router instance
const router = createRouter({ routeTree });

// Register router for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Render app
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <WalletProvider>
        <Toaster position="top-center" />
        <RouterProvider router={router} />
      </WalletProvider>
    </ThemeProvider>
  </React.StrictMode>
);
