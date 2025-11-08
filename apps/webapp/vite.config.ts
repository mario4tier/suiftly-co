import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'path';

export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true, // Fail if port is already in use (no auto-increment)
    proxy: {
      // Proxy internal endpoints to backend (same-origin)
      '/i': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
