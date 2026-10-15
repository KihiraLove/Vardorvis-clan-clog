/** Loading acceptance uses the built production graph, never Vite's source graph. */
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests-loading',
  workers: 1,
  forbidOnly: true,
  retries: 0,
  outputDir: './test-results/loading',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5189',
    browserName: 'chromium',
    channel: 'chromium',
    viewport: { width: 1100, height: 850 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      'node ../../node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5189 --strictPort',
    url: 'http://127.0.0.1:5189',
    reuseExistingServer: false,
  },
});
