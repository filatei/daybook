import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend/src',
  plugins: [react()],
  build: {
    outDir: '../../frontend/dist',
    emptyOutDir: true,
  },
  server: {
    // Dev server proxies /api to the Express backend
    proxy: {
      '/api': { target: 'http://localhost:8090', changeOrigin: true },
    },
  },
});
