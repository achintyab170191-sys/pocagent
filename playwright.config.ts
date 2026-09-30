import { defineConfig } from '@playwright/test';

const apiPort = 3100;
const webPort = 5273;

// PW_CHANNEL: "msedge" (default; uses the installed Edge, no download) | "chrome" | "" to use Playwright's bundled Chromium (npx playwright install chromium).
const channel = process.env.PW_CHANNEL === undefined ? 'msedge' : process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${webPort}`, channel, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' },
  webServer: [
    { command: 'npx tsx tests/e2e/server.ts', url: `http://127.0.0.1:${apiPort}/health`, reuseExistingServer: false, timeout: 60_000, env: { E2E_API_PORT: String(apiPort), E2E_APP_URL: `http://localhost:${webPort}`, NODE_ENV: 'test' } },
    { command: 'npm run dev --workspace @sbo/web', url: `http://localhost:${webPort}`, reuseExistingServer: false, timeout: 60_000, env: { WEB_PORT: String(webPort), API_URL: `http://127.0.0.1:${apiPort}` } },
  ],
});
