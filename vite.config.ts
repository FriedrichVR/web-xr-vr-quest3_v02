import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is mandatory for WebXR (navigator.xr requires a secure context).
// `vite --host` + basicSsl gives you https://<lan-ip>:5173 for Quest testing.
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
    port: 5173,
    https: true
  },
  preview: {
    host: true,
    port: 4173
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500
  }
});
