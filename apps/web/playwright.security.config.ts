/** Run only against the disposable production image started by compose-smoke. */
import { defineConfig } from '@playwright/test';
if (
  process.env.SECURITY_PROXY_TEST !== '1' ||
  !/^clog-checks-[a-z0-9-]+$/u.test(process.env.COMPOSE_PROJECT_NAME ?? '')
)
  throw new Error(
    'Use node scripts/check-local.mjs for disposable proxy checks',
  );
export default defineConfig({
  testDir: './tests-security',
  workers: 1,
  forbidOnly: true,
  retries: 0,
  outputDir: './test-results/security',
  reporter: 'list',
  use: {
    // Loopback supplies the browser's native secure-context APIs for demo writes.
    // This edge forwards production Nginx bytes/headers and does not fake TLS/auth.
    baseURL: 'http://127.0.0.1:5191',
    browserName: 'chromium',
    channel: 'chromium',
    viewport: { width: 1100, height: 850 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node tests-security/proxy.mjs',
    url: 'http://127.0.0.1:5191/healthz',
    reuseExistingServer: false,
  },
});
