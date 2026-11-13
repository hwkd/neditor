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
      //
      // Astro 7 detects an AI coding agent (Claude Code, Codex, ...) and then
      // starts `astro dev` as a detached background process: the command
      // returns as soon as that server is up, which Playwright almost always
      // reports as "exited early", and the server outlives the run either
      // way. ASTRO_DEV_BACKGROUND=0 is Astro's documented opt-out; Astro only
      // asks whether the variable is non-empty, so `0` works but is not read
      // as "off". Outside an agent the foreground is already the default, so
      // CI is unaffected.
      //
      // --ignore-lock: Astro's lock is per project, not per port, so any
      // other `astro dev` in this checkout (`vp run dev` on 4321, one an
      // agent's preview tool left running) otherwise refuses to start this one
      // whatever DEMO_PORT says. It also keeps this server out of the lock, so
      // `astro dev stop` cannot kill it mid-run and a run leaves no lock
      // behind -- and, by the same token, `astro dev status` cannot see it.
      // Astro allows the flag only in the foreground, hence the env.
      //
      // DEMO_STRICT_PORT makes astro.config.mjs set Vite's strictPort: when
      // Vite cannot bind DEMO_PORT, Astro exits with "Port ... is already in
      // use" instead of moving to another port that Playwright does not watch.
      // Vite binds one address, so an occupant on another address can go
      // unnoticed (OS-dependent); the run then waits out the timeout.
      command: `pnpm --filter web exec astro dev --port ${DEMO_PORT} --ignore-lock`,
      env: { ASTRO_DEV_BACKGROUND: '0', DEMO_STRICT_PORT: '1' },
      url: `http://localhost:${DEMO_PORT}`,
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
