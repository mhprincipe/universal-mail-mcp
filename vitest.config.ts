import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'testkit/test/**/*.test.ts'],
    // Protocol tests need Docker, and package tests build the project: both
    // run in the slow tier, with vitest.protocol.config.ts.
    exclude: [...configDefaults.exclude, '**/*.protocol.test.ts', '**/*.package.test.ts'],
    setupFiles: ['testkit/src/setup.ts'],
    // Many tests start real workers, git and setup's processes, and parse real
    // PDFs; with the whole suite in parallel on a busy machine (Docker running
    // beside it) 5 s wasn't enough, and a test cut off at 5 s kept running into
    // the next one's mailbox (2.4.2). A test that truly hangs still fails.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // Product code only. The test kit is proven by its own TK tests and must
      // not dilute (or inflate) the product's coverage.
      include: ['src/**/*.ts'],
      // parseWorker.ts is a few lines of message passing that run in a worker
      // thread, which V8 coverage here can't see. Every PAR test that uses the
      // worker runs through it; the parsing it calls (parseCore.ts) is measured.
      exclude: ['testkit/**', 'src/parseWorker.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Floor: v1 baseline 81/76/86/87, raised after the Accounts, Providers,
      // Safe-parsing, Threads and Protocol groups (2026-09-24) and Phase 2
      // sign-in and the Phase 3 setup log and adapter (2026-09-25), and the
      // diagnostics check, the installed server, setup's menu, everyday polish
      // and your page (2026-09-25). Raise it; never lower it.
      thresholds: { statements: 93, branches: 84, functions: 94, lines: 96 }
    }
  }
});
