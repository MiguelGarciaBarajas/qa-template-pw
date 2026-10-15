import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['html', { outputFolder: 'playwright-report' }]],
  use: {
    // Connect to shared Edge via CDP instead of launching a new browser
    connectOptions: {
      wsEndpoint: process.env.CDP_ENDPOINT ?? 'http://localhost:9222',
    },
    baseURL: process.env.APP_URL_QA ?? 'https://your-app-qa.example.com',
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'shared-edge-cdp',
      use: { ...devices['Desktop Edge'] },
    },
  ],
  outputDir: 'artifacts',
});
