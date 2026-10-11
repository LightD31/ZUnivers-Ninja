import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Chemins relatifs : l'interface fonctionne aussi bien à la racine que dans un sous-dossier (GitHub Pages).
  base: './',
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  server: {
    port: 5173,
    // Dans un conteneur de dev, VITE_HOST=0.0.0.0 rend le serveur accessible depuis l'hôte.
    host: process.env.VITE_HOST ?? 'localhost',
    proxy: { '/api': 'http://localhost:8080', '/health': 'http://localhost:8080' },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
