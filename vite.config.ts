import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    // `npm run dev` proxies the API to a local `wrangler dev` (port 8787)
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
