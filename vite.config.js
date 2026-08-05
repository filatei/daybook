import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend/src',
  plugins: [react()],
  // Build stamp shown in the app footer — so a phone screenshot immediately
  // tells us WHICH build is running (the recurring stale-SW / stale-deploy
  // debugging pain). GIT_SHA is passed as a Docker build arg by the deploy
  // workflow; local `npm run build` without it shows "dev".
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_SHA__: JSON.stringify((process.env.GIT_SHA || 'dev').slice(0, 7)),
  },
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
