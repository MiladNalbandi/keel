import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  reporter: process.env.CI ? 'github' : 'line',
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: [
    {
      command: '../gradlew -p ../apps/api bootTestRun',
      url: `${process.env.API_URL ?? 'http://localhost:8080'}/actuator/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: 'pnpm --filter web dev',
      url: process.env.BASE_URL ?? 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
