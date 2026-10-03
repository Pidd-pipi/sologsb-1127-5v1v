import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 21827,
    host: true,
    // 本地开发时把交接 API 代理到本机服务端（npm run dev --prefix server）
    proxy: {
      '/api': { target: 'http://localhost:4021', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
});
