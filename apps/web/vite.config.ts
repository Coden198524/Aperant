import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@web': resolve(__dirname, 'src'),
      '@client': resolve(__dirname, 'src/client'),
      '@shared': resolve(__dirname, '../desktop/src/shared'),
      '@preload': resolve(__dirname, '../desktop/src/preload'),
      '@': resolve(__dirname, '../desktop/src/renderer'),
      '@renderer': resolve(__dirname, '../desktop/src/renderer'),
      '@components': resolve(__dirname, '../desktop/src/renderer/components'),
      '@hooks': resolve(__dirname, '../desktop/src/renderer/hooks'),
      '@lib': resolve(__dirname, '../desktop/src/renderer/lib'),
      '@features': resolve(__dirname, '../desktop/src/renderer/features'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': {
        target: process.env.AUTOCODE_WEB_SERVICE_URL ?? 'http://127.0.0.1:4728',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: false,
  },
});
