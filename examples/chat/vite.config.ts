import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8902,
    // Everything under /api goes to this example's own backend: the
    // browser never talks to the Swalvo Control API directly, and never
    // holds a project API key.
    proxy: { '/api': 'http://localhost:8788' },
  },
});
