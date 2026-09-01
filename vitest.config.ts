import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Las pruebas contra la API real son opt-in: `npm run test:live`.
    exclude: process.env['SOLOTODO_LIVE'] ? [] : ['test/live.test.ts'],
    testTimeout: 30_000,
  },
});
