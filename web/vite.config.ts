import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the UI runs on Vite's port and proxies /api to the backend,
// so the browser sees one origin, as it does in the production build.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
