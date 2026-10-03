import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 21827,
    host: true,
    proxy: {
      // 开发环境把同步接口代理到本机 hub 服务（默认 21828）
      '/api': {
        target: process.env.VITE_SYNC_PROXY_TARGET || 'http://localhost:21828',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
});
