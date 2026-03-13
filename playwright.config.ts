import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  globalTimeout: 300_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    baseURL: undefined,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
});
