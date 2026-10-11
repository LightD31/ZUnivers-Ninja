import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Les plans sur un joueur réel prennent quelques secondes, davantage sur les machines de CI.
    testTimeout: 30_000,
  },
});
