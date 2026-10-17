import { defineConfig } from '@playwright/test';
if (
  process.env.STACK_BROWSER_TEST !== '1' ||
  !/^clog-checks-[a-z0-9-]+$/u.test(process.env.COMPOSE_PROJECT_NAME ?? '') ||
  process.env.PUBLIC_ORIGIN !== 'https://clog.example.com'
)
  throw new Error(
    'Use node scripts/check-local.mjs; disposable HTTPS browser tests only',
  );
export default defineConfig({
  testDir: './tests-stack',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60000,
  outputDir: './test-results/stack',
  reporter: [
    ['list'],
    ['json', { outputFile: '../../.data/local-checks/stack-report.json' }],
  ],
  use: {
    baseURL: 'https://clog.example.com',
    ignoreHTTPSErrors: true, // A fresh self-signed certificate exists only inside this disposable runner.
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node tests-stack/edge.mjs',
    url: 'https://clog.example.com/healthz',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
  },
});
