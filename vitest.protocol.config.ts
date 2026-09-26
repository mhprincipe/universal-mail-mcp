import { defineConfig } from 'vitest/config';

// The slow tier: real mail servers in containers (needs Docker), and the
// package tests, which build the project and run it as its own process.
export default defineConfig({
  test: {
    include: ['**/*.protocol.test.ts', '**/*.package.test.ts'],
    exclude: ['node_modules/**'],
    setupFiles: ['testkit/src/setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false
  }
});
