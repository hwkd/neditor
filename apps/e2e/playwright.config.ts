import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);
// Overridable together with the harness's own port (vite.config.ts): with
// `reuseExistingServer`, a server another checkout left on the default port
// would silently be the one under test.
const PORT = Number(process.env.E2E_PORT ?? 4390);
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 4391);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: CI,
  // Time is controlled with page.clock, never waited for, so a retry is a
  // flake report rather than a way to get green: see docs/e2e-test-plan.md §5.
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list']],
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1100, height: 800 },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1100, height: 800 },
        permissions: ['clipboard-read', 'clipboard-write'],
      },
      testIgnore: /touch\.spec\.ts/,
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1100, height: 800 } },
      testIgnore: /touch\.spec\.ts/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1100, height: 800 } },
      testIgnore: /touch\.spec\.ts/,
    },
    {
      name: 'chromium-touch',
      use: { ...devices['Pixel 7'] },
      testMatch: /touch\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'pnpm exec vp dev',
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // The Astro demo, for the smoke spec (27).
      // Not Astro's default 4321, which is often taken by another project.
      command: `pnpm --filter web exec astro dev --port ${DEMO_PORT}`,
      url: `http://localhost:${DEMO_PORT}`,
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
