import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// WEB_PORT / API_URL let the browser tests run the web client and API on non-default ports.
const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.WEB_PORT ?? 5173), strictPort: true, proxy: { '/api': apiUrl, '/health': apiUrl } },
  preview: { port: Number(process.env.WEB_PORT ?? 5173), proxy: { '/api': apiUrl, '/health': apiUrl } },
});
