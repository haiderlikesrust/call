import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT || 8787}` },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
