import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 22601, // Admin webapp port (gm API is 22600)
    strictPort: true,
    proxy: {
      // Proxy API calls to gm backend
      '/api': {
        target: 'http://localhost:22600',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
