import { defineConfig } from 'tsup';

export default defineConfig({
  // planner-thread : chargé par le pool de threads (src/pool.ts), à côté de index.js.
  entry: ['src/index.ts', 'src/planner-thread.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Fichiers autonomes : l'image Docker n'a pas besoin de node_modules.
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
