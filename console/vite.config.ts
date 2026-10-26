import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: '/console/',
  build: { sourcemap: false },
  server: { proxy: { '/v1': 'http://127.0.0.1:3000', '/api': 'http://127.0.0.1:3000' } },
});
